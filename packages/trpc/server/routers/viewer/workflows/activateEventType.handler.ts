import {
  deleteScheduledEmailReminder,
  scheduleEmailReminder,
} from "@calcom/features/ee/workflows/lib/reminders/emailReminderManager";
import {
  deleteScheduledSMSReminder,
  scheduleSMSReminder,
} from "@calcom/features/ee/workflows/lib/reminders/smsReminderManager";
import {
  deleteScheduledWhatsappReminder,
  scheduleWhatsappReminder,
} from "@calcom/features/ee/workflows/lib/reminders/whatsappReminderManager";
import { SENDER_ID, SENDER_NAME } from "@calcom/lib/constants";
import { prisma } from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/client";
import { MembershipRole, WorkflowActions, WorkflowMethods } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/trpc";

import { TRPCError } from "@trpc/server";

import type { TActivateEventTypeInputSchema } from "./activateEventType.schema";
import { removeSmsReminderFieldForBooking, upsertSmsReminderFieldForBooking } from "./util";

type ActivateEventTypeOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TActivateEventTypeInputSchema;
};

export const activateEventTypeHandler = async ({ ctx, input }: ActivateEventTypeOptions) => {
  const { eventTypeId, workflowId } = input;

  // Check that event type belong to the user or team
  const userEventType = await prisma.eventType.findFirst({
    where: {
      id: eventTypeId,
      OR: [
        { userId: ctx.user.id },
        {
          team: {
            members: {
              some: {
                userId: ctx.user.id,
                accepted: true,
                NOT: {
                  role: MembershipRole.MEMBER,
                },
              },
            },
          },
        },
      ],
    },
    include: {
      children: true,
    },
  });

  if (!userEventType)
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authorized to edit this event type" });

  // Check that the workflow belongs to the user or team
  const eventTypeWorkflow = await prisma.workflow.findFirst({
    where: {
      id: workflowId,
      OR: [
        {
          userId: ctx.user.id,
        },
        {
          teamId: userEventType.teamId || undefined,
        },
      ],
    },
    include: {
      steps: true,
    },
  });

  if (!eventTypeWorkflow)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not authorized to enable/disable this workflow",
    });

  //check if event type is already active
  const isActive = await prisma.workflowsOnEventTypes.findFirst({
    where: {
      workflowId,
      eventTypeId,
    },
  });
  if (isActive) {
    // disable workflow for this event type & delete all reminders
    const remindersToDelete = await prisma.workflowReminder.findMany({
      where: {
        booking: {
          eventTypeId: eventTypeId,
          userId: ctx.user.id,
        },
        workflowStepId: {
          in: eventTypeWorkflow.steps.map((step) => {
            return step.id;
          }),
        },
      },
      select: {
        id: true,
        referenceId: true,
        method: true,
        scheduled: true,
      },
    });

    remindersToDelete.forEach((reminder) => {
      if (reminder.method === WorkflowMethods.EMAIL) {
        deleteScheduledEmailReminder(reminder.id, reminder.referenceId);
      } else if (reminder.method === WorkflowMethods.SMS) {
        deleteScheduledSMSReminder(reminder.id, reminder.referenceId);
      } else if (reminder.method === WorkflowMethods.WHATSAPP) {
        deleteScheduledWhatsappReminder(reminder.id, reminder.referenceId);
      }
    });

    await prisma.workflowsOnEventTypes.deleteMany({
      where: {
        workflowId,
        eventTypeId: { in: [eventTypeId].concat(userEventType.children.map((ch) => ch.id)) },
      },
    });

    [eventTypeId].concat(userEventType.children.map((ch) => ch.id)).map(async (chId) => {
      await removeSmsReminderFieldForBooking({
        workflowId,
        eventTypeId: chId,
      });
    });
  } else {
    // activate workflow and schedule reminders for existing bookings

    const bookingsForReminders = await prisma.booking.findMany({
      where: {
        eventTypeId: eventTypeId,
        status: BookingStatus.ACCEPTED,
        startTime: {
          gte: new Date(),
        },
      },
      include: {
        attendees: true,
        eventType: true,
        user: true,
      },
    });

    for (const booking of bookingsForReminders) {
      const defaultLocale = "en";
      const bookingInfo = {
        uid: booking.uid,
        attendees: booking.attendees.map((attendee) => {
          return {
            name: attendee.name,
            email: attendee.email,
            timeZone: attendee.timeZone,
            language: { locale: attendee.locale || defaultLocale },
          };
        }),
        organizer: booking.user
          ? {
              name: booking.user.name || "",
              email: booking.user.email,
              timeZone: booking.user.timeZone,
              language: { locale: booking.user.locale || defaultLocale },
            }
          : { name: "", email: "", timeZone: "", language: { locale: "" } },
        startTime: booking.startTime.toISOString(),
        endTime: booking.endTime.toISOString(),
        title: booking.title,
        language: { locale: booking?.user?.locale || defaultLocale },
        eventType: {
          slug: booking.eventType?.slug,
        },
      };
      for (const step of eventTypeWorkflow.steps) {
        if (step.action === WorkflowActions.EMAIL_ATTENDEE || step.action === WorkflowActions.EMAIL_HOST) {
          let sendTo: string[] = [];

          switch (step.action) {
            case WorkflowActions.EMAIL_HOST:
              sendTo = [bookingInfo.organizer?.email];
              break;
            case WorkflowActions.EMAIL_ATTENDEE:
              sendTo = bookingInfo.attendees.map((attendee) => attendee.email);
              break;
          }

          await scheduleEmailReminder(
            bookingInfo,
            eventTypeWorkflow.trigger,
            step.action,
            {
              time: eventTypeWorkflow.time,
              timeUnit: eventTypeWorkflow.timeUnit,
            },
            sendTo,
            step.emailSubject || "",
            step.reminderBody || "",
            step.id,
            step.template,
            step.sender || SENDER_NAME
          );
        } else if (step.action === WorkflowActions.SMS_NUMBER && step.sendTo) {
          await scheduleSMSReminder(
            bookingInfo,
            step.sendTo,
            eventTypeWorkflow.trigger,
            step.action,
            {
              time: eventTypeWorkflow.time,
              timeUnit: eventTypeWorkflow.timeUnit,
            },
            step.reminderBody || "",
            step.id,
            step.template,
            step.sender || SENDER_ID,
            booking.userId,
            eventTypeWorkflow.teamId
          );
        } else if (step.action === WorkflowActions.WHATSAPP_NUMBER && step.sendTo) {
          await scheduleWhatsappReminder(
            bookingInfo,
            step.sendTo,
            eventTypeWorkflow.trigger,
            step.action,
            {
              time: eventTypeWorkflow.time,
              timeUnit: eventTypeWorkflow.timeUnit,
            },
            step.reminderBody || "",
            step.id,
            step.template,
            booking.userId,
            eventTypeWorkflow.teamId
          );
        }
      }
    }

    await prisma.workflowsOnEventTypes.createMany({
      data: [
        {
          workflowId,
          eventTypeId,
        },
      ].concat(userEventType.children.map((ch) => ({ workflowId, eventTypeId: ch.id }))),
    });
    const requiresAttendeeNumber = (action: WorkflowActions) =>
      action === WorkflowActions.SMS_ATTENDEE || action === WorkflowActions.WHATSAPP_ATTENDEE;

    if (eventTypeWorkflow.steps.some((step) => requiresAttendeeNumber(step.action))) {
      const isSmsReminderNumberRequired = eventTypeWorkflow.steps.some((step) => {
        return requiresAttendeeNumber(step.action) && step.numberRequired;
      });
      [eventTypeId].concat(userEventType.children.map((ch) => ch.id)).map(async (evTyId) => {
        await upsertSmsReminderFieldForBooking({
          workflowId,
          isSmsReminderNumberRequired,
          eventTypeId: evTyId,
        });
      });
    }
  }
};

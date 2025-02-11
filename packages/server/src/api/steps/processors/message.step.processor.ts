/* eslint-disable no-case-declarations */
import { HttpException, HttpStatus, Inject, Logger } from '@nestjs/common';
import * as http from 'node:http';
import https from 'https';
import { Injectable } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import {
  Processor,
  WorkerHost,
  InjectQueue,
  OnWorkerEvent,
} from '@nestjs/bullmq';
import { Job, MetricsTime, Queue } from 'bullmq';
import { StepType } from '../types/step.interface';
import { Step } from '../entities/step.entity';
import { CustomerDocument } from '@/api/customers/schemas/customer.schema';
import { Account } from '@/api/accounts/entities/accounts.entity';
import * as _ from 'lodash';
import * as Sentry from '@sentry/node';
import { JourneyLocationsService } from '@/api/journeys/journey-locations.service';
import { StepsService } from '../steps.service';
import { Journey } from '@/api/journeys/entities/journey.entity';
import { JourneyLocation } from '@/api/journeys/entities/journey-location.entity';
import { CacheService } from '@/common/services/cache.service';
import { JourneysService } from '@/api/journeys/journeys.service';
import { convertTimeToUTC, isWithinInterval } from '@/common/helper/timing';
import { JourneySettingsQuietFallbackBehavior } from '@/api/journeys/types/additional-journey-settings.interface';
import {
  Template,
  TemplateType,
} from '@/api/templates/entities/template.entity';
import { TemplatesService } from '@/api/templates/templates.service';
import { cleanTagsForSending } from '../../../shared/utils/helpers';
import { MessageSender } from '../types/messagesender.class';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClickHouseEventProvider,
  WebhooksService,
} from '@/api/webhooks/webhooks.service';

@Injectable()
@Processor('{message.step}', {
  stalledInterval: process.env.MESSAGE_STEP_PROCESSOR_STALLED_INTERVAL
    ? +process.env.MESSAGE_STEP_PROCESSOR_STALLED_INTERVAL
    : 600000,
  removeOnComplete: {
    age: 0,
    count: process.env.MESSAGE_STEP_PROCESSOR_REMOVE_ON_COMPLETE
      ? +process.env.MESSAGE_STEP_PROCESSOR_REMOVE_ON_COMPLETE
      : 0,
  },
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK,
  },
  concurrency: process.env.MESSAGE_STEP_PROCESSOR_CONCURRENCY
    ? +process.env.MESSAGE_STEP_PROCESSOR_CONCURRENCY
    : 1,
})
export class MessageStepProcessor extends WorkerHost {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    @InjectQueue('{start.step}') private readonly startStepQueue: Queue,
    @InjectQueue('{wait.until.step}')
    private readonly waitUntilStepQueue: Queue,
    @InjectQueue('{message.step}') private readonly messageStepQueue: Queue,
    @InjectQueue('{jump.to.step}') private readonly jumpToStepQueue: Queue,
    @InjectQueue('{time.delay.step}')
    private readonly timeDelayStepQueue: Queue,
    @InjectQueue('{time.window.step}')
    private readonly timeWindowStepQueue: Queue,
    @InjectQueue('{multisplit.step}')
    private readonly multisplitStepQueue: Queue,
    @InjectQueue('{experiment.step}')
    private readonly experimentStepQueue: Queue,
    @InjectQueue('{exit.step}') private readonly exitStepQueue: Queue,
    @Inject(JourneyLocationsService)
    private journeyLocationsService: JourneyLocationsService,
    @Inject(JourneysService)
    private journeysService: JourneysService,
    @Inject(StepsService) private stepsService: StepsService,
    @Inject(CacheService) private cacheService: CacheService,
    @Inject(TemplatesService) private templatesService: TemplatesService,
    @InjectRepository(Account)
    private accountRepository: Repository<Account>,
    @Inject(WebhooksService)
    private readonly webhooksService: WebhooksService,
    @InjectQueue('{webhooks}') private readonly webhooksQueue: Queue
  ) {
    super();
  }

  log(message, method, session, user = 'ANONYMOUS') {
    this.logger.log(
      message,
      JSON.stringify({
        class: MessageStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  debug(message, method, session, user = 'ANONYMOUS') {
    this.logger.debug(
      message,
      JSON.stringify({
        class: MessageStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  warn(message, method, session, user = 'ANONYMOUS') {
    this.logger.warn(
      message,
      JSON.stringify({
        class: MessageStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  error(error, method, session, user = 'ANONYMOUS') {
    this.logger.error(
      error.message,
      error.stack,
      JSON.stringify({
        class: MessageStepProcessor.name,
        method: method,
        session: session,
        cause: error.cause,
        name: error.name,
        user: user,
      })
    );
  }
  verbose(message, method, session, user = 'ANONYMOUS') {
    this.logger.verbose(
      message,
      JSON.stringify({
        class: MessageStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }

  private processorMap: Record<
    StepType,
    (type: StepType, job: any) => Promise<void>
  > = {
    [StepType.START]: async (type, job) => {
      await this.startStepQueue.add(type, job);
    },
    [StepType.EXPERIMENT]: async (type, job) => {
      await this.experimentStepQueue.add(type, job);
    },
    [StepType.LOOP]: async (type, job) => {
      await this.jumpToStepQueue.add(type, job);
    },
    [StepType.EXIT]: async (type, job) => {
      await this.exitStepQueue.add(type, job);
    },
    [StepType.MULTISPLIT]: async (type, job) => {
      await this.multisplitStepQueue.add(type, job);
    },
    [StepType.MESSAGE]: async (type: StepType, job: any) => {
      await this.messageStepQueue.add(type, job);
    },
    [StepType.TIME_WINDOW]: async (type: StepType, job: any) => {
      await this.timeWindowStepQueue.add(type, job);
    },
    [StepType.TIME_DELAY]: async (type: StepType, job: any) => {
      await this.timeDelayStepQueue.add(type, job);
    },
    [StepType.WAIT_UNTIL_BRANCH]: async (type: StepType, job: any) => {
      await this.waitUntilStepQueue.add(type, job);
    },
    [StepType.AB_TEST]: function (type: StepType, job: any): Promise<void> {
      throw new Error('Function not implemented.');
    },
    [StepType.RANDOM_COHORT_BRANCH]: function (
      type: StepType,
      job: any
    ): Promise<void> {
      throw new Error('Function not implemented.');
    },
    [StepType.TRACKER]: function (type: StepType, job: any): Promise<void> {
      throw new Error('Function not implemented.');
    },
    [StepType.ATTRIBUTE_BRANCH]: function (
      type: StepType,
      job: any
    ): Promise<void> {
      throw new Error('Function not implemented.');
    },
  };

  async process(
    job: Job<
      {
        step: Step;
        owner: Account;
        journey: Journey;
        customer: CustomerDocument;
        location: JourneyLocation;
        session: string;
        event?: string;
        branch?: number;
      },
      any,
      string
    >
  ): Promise<any> {
    return Sentry.startSpan(
      { name: 'MessageStepProcessor.process' },
      async () => {
        let nextJob;
        const workspace =
          job.data.owner.teams?.[0]?.organization?.workspaces?.[0];

        // Rate limiting and sending quiet hours will be stored here
        type MessageSendType =
          | 'SEND' // should send
          | 'QUIET_REQUEUE' // quiet hours, requeue message when quiet hours over
          | 'QUIET_ABORT' // quiet hours, abort message, move to next step
          | 'LIMIT_REQUEUE' // messages per minute rate limit hit, requeue for next minute
          | 'LIMIT_HOLD' // customers messaged per journey rate limit hit, hold at current
          | 'MOCK_SEND'; // mock message send, don't actually send message
        // Initial default is 'SEND'
        let messageSendType: MessageSendType = 'SEND';
        let requeueTime: Date;
        if (
          job.data.journey.journeySettings &&
          job.data.journey.journeySettings.quietHours &&
          job.data.journey.journeySettings.quietHours.enabled
        ) {
          const quietHours = job.data.journey.journeySettings.quietHours!;
          // CHECK IF SENDING QUIET HOURS
          const formatter = Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h24',
            timeZone: 'UTC',
          });
          const now = new Date();
          const utcNowString = formatter.format(now);
          const utcStartTime = convertTimeToUTC(
            quietHours.startTime,
            workspace.timezoneUTCOffset
          );
          const utcEndTime = convertTimeToUTC(
            quietHours.endTime,
            workspace.timezoneUTCOffset
          );
          const isQuietHour = isWithinInterval(
            utcStartTime,
            utcEndTime,
            utcNowString
          );

          if (isQuietHour) {
            switch (quietHours.fallbackBehavior) {
              case JourneySettingsQuietFallbackBehavior.NextAvailableTime:
                messageSendType = 'QUIET_REQUEUE';
                break;
              case JourneySettingsQuietFallbackBehavior.Abort:
                messageSendType = 'QUIET_ABORT';
                break;
              default:
                messageSendType = 'QUIET_REQUEUE';
            }
            requeueTime = new Date(now);
            requeueTime.setUTCHours(
              parseInt(utcEndTime.split(':')[0]),
              parseInt(utcEndTime.split(':')[1]),
              0,
              0
            );
            if (requeueTime < now) {
              // Date object should handle conversions of new month/new year etc
              requeueTime.setDate(requeueTime.getDate() + 1);
            }
          }
        }

        if (messageSendType === 'SEND') {
          // 1. CHECK RATE LIMITING BY UNIQUE CUSTOMERS MESSAGED
          const [customersMessagedLimitEnabled] =
            this.journeysService.rateLimitByCustomersMessagedEnabled(
              job.data.journey
            );
          if (customersMessagedLimitEnabled) {
            const doRateLimit =
              await this.journeysService.rateLimitByCustomersMessaged(
                job.data.owner,
                job.data.journey,
                job.data.session
              );
            if (doRateLimit) {
              messageSendType = 'LIMIT_HOLD';
            }
          }
        }

        if (messageSendType === 'SEND') {
          // 2. CHECK RATE LIMITING BY NUMBER MESSAGES SENT IN LAST HOUR
          const [rateLimitByMinuteEnabled] =
            this.journeysService.rateLimitByMinuteEnabled(job.data.journey);
          if (rateLimitByMinuteEnabled) {
            const doRateLimit = await this.journeysService.rateLimitByMinute(
              job.data.owner,
              job.data.journey
            );
            if (doRateLimit) {
              messageSendType = 'LIMIT_REQUEUE';
              requeueTime = new Date();
              requeueTime.setMinutes(requeueTime.getMinutes() + 1);
            }
          }
        }

        let template: Template = await this.cacheService.getIgnoreError(
          Template,
          job.data.step.metadata.template,
          async () => {
            return await this.templatesService.lazyFindByID(
              job.data.step.metadata.template
            );
          }
        );

        if (
          messageSendType === 'SEND' &&
          process.env.MOCK_MESSAGE_SEND === 'true' &&
          template &&
          !template.webhookData
        ) {
          // 3. CHECK IF MESSAGE SEND SHOULD BE MOCKED
          messageSendType = 'MOCK_SEND';
        }

        if (messageSendType === 'SEND') {
          //send message here

          const { email } = job.data.owner;

          const {
            mailgunAPIKey,
            sendingName,
            testSendingEmail,
            testSendingName,
            sendgridApiKey,
            sendgridFromEmail,
            resendSendingDomain,
            resendAPIKey,
            resendSendingName,
            resendSendingEmail,
          } = workspace;

          let { sendingDomain, sendingEmail } = workspace;

          let key = mailgunAPIKey;
          let from = sendingName;

          const { _id, workspaceId, workflows, journeys, ...tags } =
            job.data.customer;
          const filteredTags = cleanTagsForSending(tags);
          const sender = new MessageSender(this.logger, this.accountRepository);

          switch (template.type) {
            case TemplateType.EMAIL:
              if (workspace.emailProvider === 'free3') {
                if (workspace.freeEmailsCount === 0)
                  throw new HttpException(
                    'You exceeded limit of 3 emails',
                    HttpStatus.PAYMENT_REQUIRED
                  );
                sendingDomain = process.env.MAILGUN_TEST_DOMAIN;
                key = process.env.MAILGUN_API_KEY;
                from = testSendingName;
                sendingEmail = testSendingEmail;
                workspace.freeEmailsCount--;
              }

              if (workspace.emailProvider === 'resend') {
                sendingDomain = workspace.resendSendingDomain;
                key = workspace.resendAPIKey;
                from = workspace.resendSendingName;
                sendingEmail = workspace.resendSendingEmail;
              }
              if (workspace.emailProvider === 'sendgrid') {
                key = sendgridApiKey;
                from = sendgridFromEmail;
              }
              const ret = await sender.process({
                name: TemplateType.EMAIL,
                accountID: job.data.owner.id,
                cc: template.cc,
                customerID: job.data.customer._id,
                domain: sendingDomain,
                email: sendingEmail,
                stepID: job.data.step.id,
                from: from,
                trackingEmail: email,
                key: key,
                subject: await this.templatesService.parseApiCallTags(
                  template.subject,
                  filteredTags
                ),
                to: job.data.customer.phEmail
                  ? job.data.customer.phEmail
                  : job.data.customer.email,
                text: await this.templatesService.parseApiCallTags(
                  template.text,
                  filteredTags
                ),
                tags: filteredTags,
                templateID: template.id,
                eventProvider: workspace.emailProvider,
                session: job.data.session,
              });
              await this.webhooksService.insertMessageStatusToClickhouse(
                ret,
                job.data.session
              );
              if (workspace.emailProvider === 'free3') {
                await job.data.owner.save();
                await workspace.save();
              }
              break;
            case TemplateType.PUSH:
              switch (job.data.step.metadata.selectedPlatform) {
                case 'All':
                  await this.webhooksService.insertMessageStatusToClickhouse(
                    await sender.process({
                      name: 'android',
                      accountID: job.data.owner.id,
                      stepID: job.data.step.id,
                      customerID: job.data.customer._id,
                      firebaseCredentials:
                        workspace.pushPlatforms.Android.credentials,
                      deviceToken: job.data.customer.androidDeviceToken,
                      pushTitle: template.pushObject.settings.Android.title,
                      pushText:
                        template.pushObject.settings.Android.description,
                      kvPairs: template.pushObject.fields,
                      trackingEmail: email,
                      filteredTags: filteredTags,
                      templateID: template.id,
                      quietHours: job.data.journey.journeySettings.quietHours
                        .enabled
                        ? job.data.journey.journeySettings?.quietHours
                        : undefined,
                      session: job.data.session,
                    }),
                    job.data.session
                  );
                  await this.webhooksService.insertMessageStatusToClickhouse(
                    await sender.process({
                      name: 'ios',
                      accountID: job.data.owner.id,
                      stepID: job.data.step.id,
                      customerID: job.data.customer._id,
                      firebaseCredentials:
                        workspace.pushPlatforms.iOS.credentials,
                      deviceToken: job.data.customer.iosDeviceToken,
                      pushTitle: template.pushObject.settings.iOS.title,
                      pushText: template.pushObject.settings.iOS.description,
                      kvPairs: template.pushObject.fields,
                      trackingEmail: email,
                      filteredTags: filteredTags,
                      templateID: template.id,
                      quietHours: job.data.journey.journeySettings.quietHours
                        .enabled
                        ? job.data.journey.journeySettings?.quietHours
                        : undefined,
                      session: job.data.session,
                    }),
                    job.data.session
                  );
                  break;
                case 'iOS':
                  await this.webhooksService.insertMessageStatusToClickhouse(
                    await sender.process({
                      name: 'ios',
                      accountID: job.data.owner.id,
                      stepID: job.data.step.id,
                      customerID: job.data.customer._id,
                      firebaseCredentials:
                        workspace.pushPlatforms.iOS.credentials,
                      deviceToken: job.data.customer.iosDeviceToken,
                      pushTitle: template.pushObject.settings.iOS.title,
                      pushText: template.pushObject.settings.iOS.description,
                      kvPairs: template.pushObject.fields,
                      trackingEmail: email,
                      filteredTags: filteredTags,
                      templateID: template.id,
                      quietHours: job.data.journey.journeySettings.quietHours
                        .enabled
                        ? job.data.journey.journeySettings?.quietHours
                        : undefined,
                      session: job.data.session,
                    }),
                    job.data.session
                  );
                  break;
                case 'Android':
                  await this.webhooksService.insertMessageStatusToClickhouse(
                    await sender.process({
                      name: 'android',
                      accountID: job.data.owner.id,
                      stepID: job.data.step.id,
                      customerID: job.data.customer._id,
                      firebaseCredentials:
                        workspace.pushPlatforms.Android.credentials,
                      deviceToken: job.data.customer.androidDeviceToken,
                      pushTitle: template.pushObject.settings.Android.title,
                      pushText:
                        template.pushObject.settings.Android.description,
                      trackingEmail: email,
                      kvPairs: template.pushObject.fields,
                      filteredTags: filteredTags,
                      templateID: template.id,
                      quietHours: job.data.journey.journeySettings.quietHours
                        .enabled
                        ? job.data.journey.journeySettings?.quietHours
                        : undefined,
                      session: job.data.session,
                    }),
                    job.data.session
                  );
                  break;
              }
              break;
            case TemplateType.SMS:
              await this.webhooksService.insertMessageStatusToClickhouse(
                await sender.process({
                  name: TemplateType.SMS,
                  accountID: job.data.owner.id,
                  stepID: job.data.step.id,
                  customerID: job.data.customer._id,
                  templateID: template.id,
                  from: workspace.smsFrom,
                  sid: workspace.smsAccountSid,
                  tags: filteredTags,
                  text: await this.templatesService.parseApiCallTags(
                    template.smsText,
                    filteredTags
                  ),
                  to:
                    job.data.customer.phPhoneNumber || job.data.customer.phone,
                  token: workspace.smsAuthToken,
                  trackingEmail: email,
                  session: job.data.session,
                }),
                job.data.session
              );
              break;
            case TemplateType.WEBHOOK: //TODO:remove this from queue
              if (template.webhookData) {
                await this.webhooksQueue.add('whapicall', {
                  template,
                  filteredTags,
                  stepId: job.data.step.id,
                  customerId: job.data.customer._id,
                  accountId: job.data.owner.id,
                });
              }
              break;
          }

          // After send, update rate limit stuff
          // await this.journeyLocationsService.setMessageSent(location);
          job.data.location = { ...job.data.location, messageSent: true };
          await this.journeysService.rateLimitByMinuteIncrement(
            job.data.owner,
            job.data.journey
          );
        } else if (messageSendType === 'QUIET_ABORT') {
          // Record that the message was aborted
          await this.webhooksService.insertMessageStatusToClickhouse(
            [
              {
                stepId: job.data.step.id,
                createdAt: new Date().toISOString(),
                customerId: job.data.customer._id,
                event: 'aborted',
                eventProvider: ClickHouseEventProvider.TRACKER,
                messageId: job.data.step.metadata.humanReadableName,
                templateId: job.data.step.metadata.template,
                workspaceId: workspace.id,
                processed: true,
              },
            ],
            job.data.session
          );
        } else if (messageSendType === 'MOCK_SEND') {
          if (process.env.MOCK_MESSAGE_SEND_URL) {
            try {
              const MOCK_MESSAGE_SEND_URL = new URL(
                process.env.MOCK_MESSAGE_SEND_URL
              );
              if (MOCK_MESSAGE_SEND_URL.protocol === 'http:') {
                await http.get(MOCK_MESSAGE_SEND_URL);
              } else if (MOCK_MESSAGE_SEND_URL.protocol === 'https:') {
                await https.get(MOCK_MESSAGE_SEND_URL);
              }
            } catch (e) {
              this.error(
                e,
                this.process.name,
                job.data.session,
                job.data.owner.email
              );
            }
          }
          await this.webhooksService.insertMessageStatusToClickhouse(
            [
              {
                stepId: job.data.step.id,
                createdAt: new Date().toISOString(),
                customerId: job.data.customer._id,
                event: 'sent',
                eventProvider: ClickHouseEventProvider.TRACKER,
                messageId: job.data.step.metadata.humanReadableName,
                templateId: job.data.step.metadata.template,
                workspaceId: workspace.id,
                processed: true,
              },
            ],
            job.data.session
          );
          // After mock send, update rate limit stuff
          // await this.journeyLocationsService.setMessageSent(location);
          job.data.location = { ...job.data.location, messageSent: true };
          await this.journeysService.rateLimitByMinuteIncrement(
            job.data.owner,
            job.data.journey
          );
        } else if (messageSendType === 'LIMIT_HOLD') {
          await this.journeyLocationsService.unlock(
            job.data.location,
            job.data.step
          );
          return;
        } else if (
          messageSendType === 'QUIET_REQUEUE' ||
          messageSendType === 'LIMIT_REQUEUE'
        ) {
          await this.stepsService.requeueMessage(
            job.data.owner,
            job.data.step,
            job.data.customer._id,
            requeueTime,
            job.data.session
          );
          await this.journeyLocationsService.unlock(
            job.data.location,
            job.data.step
          );
          return;
        }

        let nextStep: Step = await this.cacheService.getIgnoreError(
          Step,
          job.data.step.metadata.destination,
          async () => {
            return await this.stepsService.lazyFindByID(
              job.data.step.metadata.destination
            );
          }
        );

        if (nextStep) {
          if (
            nextStep.type !== StepType.TIME_DELAY &&
            nextStep.type !== StepType.TIME_WINDOW &&
            nextStep.type !== StepType.WAIT_UNTIL_BRANCH
          ) {
            nextJob = {
              owner: job.data.owner,
              journey: job.data.journey,
              step: nextStep,
              session: job.data.session,
              customer: job.data.customer,
              location: job.data.location,
              event: job.data.event,
            };
          } else {
            // Destination is time based,
            // customer has stopped moving so we can release lock
            await this.journeyLocationsService.unlock(
              job.data.location,
              nextStep
            );
          }
        } else {
          // Destination does not exist,
          // customer has stopped moving so we can release lock
          await this.journeyLocationsService.unlock(
            job.data.location,
            job.data.step
          );
        }
        if (nextStep && nextJob)
          await this.processorMap[nextStep.type](nextStep.type, nextJob);
      }
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error, prev?: string) {
    Sentry.withScope((scope) => {
      scope.setTag('job_id', job.id);
      scope.setTag('processor', MessageStepProcessor.name);
      Sentry.captureException(error);
    });
  }
}

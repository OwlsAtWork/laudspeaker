import {
  Injectable,
  Inject,
  Logger,
  HttpException,
  forwardRef,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Correlation, CustomersService } from '../customers/customers.service';
import { CustomerDocument } from '../customers/schemas/customer.schema';
import { AttributeType } from '../customers/schemas/customer-keys.schema';
import {
  EventsTable,
  CustomEventTable,
  JobTypes,
} from './interfaces/event.interface';
import { Account } from '../accounts/entities/accounts.entity';
import { PosthogBatchEventDto } from './dto/posthog-batch-event.dto';
import { EventDto } from './dto/event.dto';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { StatusJobDto } from './dto/status-event.dto';
import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import mongoose, { ClientSession, Model, SortOrder } from 'mongoose';
import { EventDocument, Event } from './schemas/event.schema';
import mockData from '../../fixtures/mockData';
import { EventKeys, EventKeysDocument } from './schemas/event-keys.schema';
import { attributeConditions } from '../../fixtures/attributeConditions';
import keyTypes from '../../fixtures/keyTypes';
import { PostHogEventDto } from './dto/posthog-event.dto';
import defaultEventKeys from '../../fixtures/defaultEventKeys';
import {
  PosthogEventType,
  PosthogEventTypeDocument,
} from './schemas/posthog-event-type.schema';
import { DataSource } from 'typeorm';
import posthogEventMappings from '../../fixtures/posthogEventMappings';
import {
  PosthogEvent,
  PosthogEventDocument,
} from './schemas/posthog-event.schema';
import { JourneysService } from '../journeys/journeys.service';
import admin from 'firebase-admin';
import { Journey } from '../journeys/entities/journey.entity';
import { CustomerPushTest } from './dto/customer-push-test.dto';
import {
  PlatformSettings,
  PushPlatforms,
} from '../templates/entities/template.entity';
import { Workspaces } from '../workspaces/entities/workspaces.entity';
import { ProviderType } from './events.preprocessor';
import { SendFCMDto } from './dto/send-fcm.dto';
import { IdentifyCustomerDTO } from './dto/identify-customer.dto';
import {
  CustomerKeys,
  CustomerKeysDocument,
} from '../customers/schemas/customer-keys.schema';
import { SetCustomerPropsDTO } from './dto/set-customer-props.dto';
import { MobileBatchDto } from './dto/mobile-batch.dto';
import e from 'express';
import {
  ClickHouseEventProvider,
  ClickHouseMessage,
  WebhooksService,
} from '../webhooks/webhooks.service';
import { Liquid } from 'liquidjs';
import { cleanTagsForSending } from '@/shared/utils/helpers';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/node';

@Injectable()
export class EventsService {
  private tagEngine = new Liquid();

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => CustomersService))
    private readonly customersService: CustomersService,
    @Inject(forwardRef(() => WebhooksService))
    private readonly webhooksService: WebhooksService,
    @InjectModel(CustomerKeys.name)
    public CustomerKeysModel: Model<CustomerKeysDocument>,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    @InjectQueue('{message}') private readonly messageQueue: Queue,
    @InjectQueue('{events}') private readonly eventQueue: Queue,
    @InjectQueue('{events_pre}')
    private readonly eventPreprocessorQueue: Queue,
    @InjectQueue('{slack}') private readonly slackQueue: Queue,
    @InjectModel(Event.name)
    private EventModel: Model<EventDocument>,
    @InjectModel(PosthogEvent.name)
    private PosthogEventModel: Model<PosthogEventDocument>,
    @InjectModel(EventKeys.name)
    private EventKeysModel: Model<EventKeysDocument>,
    @InjectRepository(Account)
    public accountsRepository: Repository<Account>,
    @InjectModel(PosthogEventType.name)
    private PosthogEventTypeModel: Model<PosthogEventTypeDocument>,
    @InjectConnection() private readonly connection: mongoose.Connection,
    @InjectQueue('{webhooks}') private readonly webhooksQueue: Queue,
    @Inject(forwardRef(() => JourneysService))
    private readonly journeysService: JourneysService
  ) {
    this.tagEngine.registerTag('api_call', {
      parse(token) {
        this.items = token.args.split(' ');
      },
      async render(ctx) {
        const url = this.liquid.parseAndRenderSync(
          this.items[0],
          ctx.getAll(),
          ctx.opts
        );

        try {
          const res = await fetch(url, { method: 'GET' });

          if (res.status !== 200)
            throw new Error('Error while processing api_call tag');

          const data = res.headers
            .get('Content-Type')
            .includes('application/json')
            ? await res.json()
            : await res.text();

          if (this.items[1] === ':save' && this.items[2]) {
            ctx.push({ [this.items[2]]: data });
          }
        } catch (e) {
          throw new Error('Error while processing api_call tag');
        }
      },
    });

    const session = randomUUID();
    (async () => {
      try {
        const collection = this.connection.db.collection('events');
        await collection.createIndex({ event: 1, workspaceId: 1 });
        await collection.createIndex({ correlationKey: 1, workspaceId: 1 });
        await collection.createIndex({ correlationValue: 1, workspaceId: 1 });
        await collection.createIndex({ createdAt: 1 });
        await collection.createIndex({ workspaceId: 1, _id: -1 });
        await collection.createIndex({ event: 'text' });
      } catch (e) {
        this.error(e, EventsService.name, session);
      }
    })();
    for (const { name, property_type } of defaultEventKeys) {
      if (name && property_type) {
        this.EventKeysModel.updateOne(
          { key: name },
          {
            key: name,
            type: property_type,
            providerSpecific: 'posthog',
            isDefault: true,
          },
          { upsert: true }
        ).exec();
      }
    }
    for (const { name, displayName, type, event } of posthogEventMappings) {
      if (name && displayName && type && event) {
        this.PosthogEventTypeModel.updateOne(
          { name: name },
          {
            name: name,
            displayName: displayName,
            type: type,
            event: event,
            isDefault: true,
          },
          { upsert: true }
        ).exec();
      }
    }
  }

  log(message, method, session, user = 'ANONYMOUS') {
    this.logger.log(
      message,
      JSON.stringify({
        class: EventsService.name,
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
        class: EventsService.name,
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
        class: EventsService.name,
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
        class: EventsService.name,
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
        class: EventsService.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }

  async correlate(
    account: Account,
    ev: EventsTable
  ): Promise<CustomerDocument> {
    return this.customersService.findByExternalIdOrCreate(
      account,
      ev.userId ? ev.userId : ev.anonymousId
    );
  }

  async correlateCustomEvent(
    account: Account,
    ev: CustomEventTable
  ): Promise<Correlation> {
    return this.customersService.findByCustomEvent(account, ev.slackId);
  }

  async getJobStatus(body: StatusJobDto, type: JobTypes, session: string) {
    const jobQueues = {
      [JobTypes.email]: this.messageQueue,
      [JobTypes.slack]: this.slackQueue,
      [JobTypes.events]: this.eventQueue,
      [JobTypes.webhooks]: this.webhooksQueue,
    };

    try {
      const job = await jobQueues[type].getJob(body.jobId);
      const state = await job.getState();
      return state;
    } catch (err) {
      this.logger.error(`Error getting ${type} job status: ` + err);
      throw new HttpException(`Error getting ${type} job status`, 503);
    }
  }

  async posthogPayload(
    account: Account,
    eventDto: PosthogBatchEventDto,
    session: string
  ) {
    let err: any;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.manager.save(Account, {
        id: account.id,
        posthogSetupped: true,
      });

      const chronologicalEvents: PostHogEventDto[] = eventDto.batch.sort(
        (a, b) =>
          new Date(a.originalTimestamp).getTime() -
          new Date(b.originalTimestamp).getTime()
      );

      for (
        let numEvent = 0;
        numEvent < chronologicalEvents.length;
        numEvent++
      ) {
        await this.eventPreprocessorQueue.add(
          'posthog',
          {
            account: account,
            event: eventDto,
            session: session,
          },
          {
            attempts: 10,
            backoff: { delay: 1000, type: 'exponential' },
          }
        );
      }
    } catch (e) {
      await queryRunner.rollbackTransaction();
      err = e;
    } finally {
      await queryRunner.release();
      if (err) throw err;
    }
  }

  async customPayload(
    auth: { account: Account; workspace: Workspaces },
    eventDto: EventDto,
    session: string
  ) {
    await this.eventPreprocessorQueue.add(ProviderType.LAUDSPEAKER, {
      owner: auth.account,
      workspace: auth.workspace,
      event: eventDto,
      session: session,
    });
  }

  async getOrUpdateAttributes(resourceId: string, session: string) {
    const attributes = await this.EventKeysModel.find().exec();
    if (resourceId === 'attributes') {
      return {
        id: resourceId,
        nextResourceURL: 'attributeConditions',
        options: attributes.map((attribute) => ({
          label: attribute.key,
          id: attribute.key,
          nextResourceURL: attribute.key,
        })),
        type: 'select',
      };
    }

    const attribute = attributes.find(
      (attribute) => attribute.key === resourceId
    );
    if (attribute)
      return {
        id: resourceId,
        options: attributeConditions(attribute.type, attribute.isArray),
        type: 'select',
      };

    return (
      mockData.resources.find((resource) => resource.id === resourceId) || {}
    );
  }

  async getAttributes(
    resourceId: string,
    ownerId: string,
    session: string,
    providerSpecific?: string
  ) {
    const account = await this.accountsRepository.findOne({
      where: { id: ownerId },
      relations: ['teams.organization.workspaces'],
    });
    const workspace = account?.teams?.[0]?.organization?.workspaces?.[0];

    const attributes = await this.EventKeysModel.find({
      $and: [
        { key: RegExp(`.*${resourceId}.*`, 'i') },
        { $or: [{ workspaceId: workspace.id }, { isDefault: true }] },
      ],
      providerSpecific,
    }).exec();

    return attributes.map((el) => ({
      id: el.id,
      key: el.key,
      type: el.type,
      isArray: el.isArray,
      options: attributeConditions(el.type, el.isArray),
    }));
  }

  async getPossibleEventNames(account: Account, search: string) {
    account = await this.accountsRepository.findOne({
      where: { id: account.id },
      relations: ['teams.organization.workspaces'],
    });
    const workspace = account?.teams?.[0]?.organization?.workspaces?.[0];

    const eventNames = await this.EventModel.find({
      $and: [
        { workspaceId: workspace.id },
        { event: RegExp(`.*${search}.*`, 'i') },
      ],
    })
      .distinct('event')
      .exec();

    return eventNames;
  }

  async getPossibleEventProperties(
    account: Account,
    event: string,
    search: string
  ) {
    account = await this.accountsRepository.findOne({
      where: { id: account.id },
      relations: ['teams.organization.workspaces'],
    });
    const workspace = account?.teams?.[0]?.organization?.workspaces?.[0];

    const records = await this.EventModel.find({
      $and: [{ workspaceId: workspace.id }, { event }],
    }).exec();

    if (records.length === 0) return [];

    const uniqueProperties: string[] = records
      .map((record) => Object.keys(record.payload))
      .reduce((acc, el) => [...acc, ...el])
      .reduce((acc, el) => (acc.includes(el) ? acc : [...acc, el]), []);

    return uniqueProperties.filter((property) =>
      property.match(RegExp(`.*${search}.*`, 'i'))
    );
  }

  async getPossibleTypes(session: string) {
    return keyTypes;
  }

  async getPossibleComparisonTypes(
    type: string,
    session: string,
    isArray = false
  ) {
    return attributeConditions(type, isArray);
  }

  async getPossibleValues(key: string, search: string, session: string) {
    const searchRegExp = new RegExp(`.*${search}.*`, 'i');
    const docs = await this.EventModel.aggregate([
      { $match: { [`event.${key}`]: searchRegExp } },
      { $group: { _id: `$event.${key}` } },
      { $limit: 5 },
    ]).exec();
    return docs.map((doc) => doc?.['event']?.[key]).filter((item) => item);
  }

  async getPossiblePosthogTypes(ownerId: string, session: string, search = '') {
    const searchRegExp = new RegExp(`.*${search}.*`, 'i');
    // TODO: need to recheck, filtering not working in a correct way
    const types = await this.PosthogEventTypeModel.find({
      $and: [
        { name: searchRegExp },
        { $or: [{ ownerId }, { isDefault: true }] },
      ],
    }).exec();
    return types.map((type) => type.displayName);
  }

  async getPosthogEvents(
    account: Account,
    session: string,
    take = 100,
    skip = 0,
    search = ''
  ) {
    const searchRegExp = new RegExp(`.*${search}.*`, 'i');

    const totalPages =
      Math.ceil(
        (await this.PosthogEventModel.count({
          name: searchRegExp,
          ownerId: (<Account>account).id,
        }).exec()) / take
      ) || 1;

    const posthogEvents = await this.PosthogEventModel.find({
      name: searchRegExp,
      ownerId: (<Account>account).id,
    })
      .sort({ createdAt: 'desc' })
      .skip(skip)
      .limit(take > 100 ? 100 : take)
      .exec();

    return {
      data: posthogEvents.map((posthogEvent) => ({
        ...posthogEvent.toObject(),
        createdAt: posthogEvent._id.getTimestamp(),
      })),
      totalPages,
    };
  }

  /*
   *
   * Retrieves a number of events for the user to see in the event tracker
   * uses mongo aggregation
   */
  async getCustomEvents(
    account: Account,
    session: string,
    take = 100,
    search = '',
    anchor = '',
    id = '',
    lastPageId = ''
  ) {
    return Sentry.startSpan(
      { name: 'EventsService.getCustomEvents' },
      async () => {
        this.debug(
          ` in customEvents`,
          this.getCustomEvents.name,
          session,
          account.id
        );

        const result = await this.getCustomEventsCursorSearch(
          account,
          session,
          take,
          search,
          anchor,
          id,
          lastPageId
        );

        return result;
      }
    );
  }

  async getCustomEventsCursorSearch(
    account: Account,
    session: string,
    pageSize: number,
    search: string,
    anchor: string,
    cursorEventId: string,
    lastPageId: string
  ) {
    let direction;
    // anchor options: first_page, previous, next, last_page
    // direction: 1 or -1. 1 means we're going to the next page, -1 means previous
    // cursorEventId is the event id we need to search after or before, depending
    // on the direction
    ({ anchor, direction, cursorEventId } =
      this.computeCustomEventsQueryVariables(anchor, direction, cursorEventId));
    const { filter, sort, limit } = this.prepareCustomEventsQuery(
      account,
      pageSize,
      search,
      anchor,
      direction,
      cursorEventId
    );

    const customEvents = await this.executeCustomEventsQuery(
      filter,
      sort,
      limit
    );

    var resultSetHasMoreThanPageSize = false;

    // since we always fetch pageSize + 1 events, pop the last element in the resultset
    if (customEvents.length > pageSize) {
      customEvents.pop();
      resultSetHasMoreThanPageSize = true;
    }

    // if we're going the reverse direction (direction == -1 / previous page)
    // we need to reverse the customEvents array so we have the most recent
    // event at the top
    if (direction == -1) {
      customEvents.reverse();
    }

    var showNext =
      (direction == 1 && resultSetHasMoreThanPageSize) ||
      (direction == -1 && anchor == 'previous');
    var showPrev =
      (direction == -1 && resultSetHasMoreThanPageSize) ||
      (direction == 1 && anchor == 'next');
    var showLast =
      (anchor == 'first_page' && resultSetHasMoreThanPageSize) ||
      anchor != 'last_page' ||
      (direction == 1 && resultSetHasMoreThanPageSize);

    var showNextCursorEventId = '';
    var showPrevCursorEventId = '';

    if (showNext)
      showNextCursorEventId = customEvents[customEvents.length - 1]._id;

    if (showPrev) showPrevCursorEventId = customEvents[0]._id;

    const filteredCustomEvents =
      this.filterCustomEventsAttributes(customEvents);

    const result = {
      data: filteredCustomEvents,
      showPrev: showPrev,
      showNext: showNext,
      showPrevCursorEventId: showPrevCursorEventId,
      showNextCursorEventId: showNextCursorEventId,
      showLast: showLast,
      anchor: anchor,
    };

    return result;
  }

  computeCustomEventsQueryVariables(
    anchor: string,
    direction: number,
    cursorEventId: string
  ) {
    // initial load of events_tracker page
    if (cursorEventId == '' && anchor == '') {
      anchor = 'first_page';
    }

    if (anchor == 'first_page') {
      direction = 1;
      cursorEventId = '';
    } else if (anchor == 'last_page') {
      direction = -1;
      cursorEventId = '';
    } else if (anchor == 'next') {
      direction = 1;
    } else if (anchor == 'previous') {
      direction = -1;
    }

    return { anchor, direction, cursorEventId };
  }

  prepareCustomEventsQuery(
    account: Account,
    pageSize: number,
    search: string,
    anchor: string,
    direction: number,
    cursorEventId: string
  ) {
    const workspace = account?.teams?.[0]?.organization?.workspaces?.[0];

    const filter = {
      workspaceId: workspace.id,
    };

    if (search !== '') {
      const searchRegExp = new RegExp(`.*${search}.*`, 'i');
      filter['event'] = searchRegExp;

      // disable the use of text index until autocomplete is implemented
      // text search supports whole word search only
      // const searchObj = {
      //   $search: `"${search}"`,
      //   $caseSensitive: false
      // }

      // filter["$text"] = searchObj;
    }

    // default sort is most recent events first (_id desc)
    const sort: Record<string, SortOrder> = {
      _id: -1,
    };

    // next page should find events with id < last event id on current page
    if (direction == 1) {
      if (cursorEventId != '')
        filter['_id'] = { $lt: new mongoose.Types.ObjectId(cursorEventId) };
    }
    // previous page should find the first events with id > first event id on current page
    else {
      if (cursorEventId != '')
        filter['_id'] = { $gt: new mongoose.Types.ObjectId(cursorEventId) };
      sort['_id'] = 1;
    }

    // fetch one more to find out if there is a next page
    // if direction == 1, then next page is ->
    const limit = pageSize + 1;

    const query = {
      filter,
      sort,
      limit,
    };

    return query;
  }

  async executeCustomEventsQuery(
    filter: Record<string, any>,
    sort: Record<string, SortOrder>,
    limit: number
  ) {
    const projection = {};

    const result = await this.EventModel.find(filter, projection)
      .sort(sort)
      .limit(limit)
      .lean()
      .exec();

    const parsedResult = this.parseCustomEventsQueryResult(result);

    return parsedResult;
  }

  parseCustomEventsQueryResult(result) {
    for (var i = 0; i < result.length; i++) {
      result[i]._id = result[i]._id.toString();
    }

    return result;
  }

  filterCustomEventsAttributes(customEvents) {
    const attributesToRemove = ['_id', 'workspaceId'];

    for (const attribute of attributesToRemove) {
      for (var i = 0; i < customEvents.length; i++) {
        delete customEvents[i][attribute];
      }
    }

    return customEvents;
  }

  //to do need to specify how this is
  async getEventsByMongo(mongoQuery: any, customer: CustomerDocument) {
    //console.log("In getEvents by mongo");

    // const tehevents = await this.EventModel.find(mongoQuery).exec();
    //console.log("events are", JSON.stringify(tehevents, null, 2))

    //console.log("events are", JSON.stringify(await this.EventModel.find(mongoQuery).exec(),null, 2));
    const count = await this.EventModel.count(mongoQuery).exec();
    //console.log("count is", count);
    return count;
  }

  //to do need to specify how this is
  async getCustomersbyEventsMongo(
    aggregationPipeline: any
    //externalId: boolean,
    //numberOfTimes: Number,
  ) {
    //console.log("In getCustomersbyEventsMongo by mongo");

    const docs = await this.EventModel.aggregate(aggregationPipeline).exec();

    return docs;
  }

  async sendTestPush(account: Account, token: string) {
    const workspace = account.teams?.[0]?.organization?.workspaces?.[0];

    const hasConnected = Object.values(workspace.pushPlatforms).some(
      (el) => !!el
    );

    if (!hasConnected) {
      throw new HttpException(
        "You don't have platform's connected",
        HttpStatus.NOT_ACCEPTABLE
      );
    }

    await Promise.all(
      Object.keys(workspace.pushPlatforms)
        .filter((el) => !!workspace.pushPlatforms[el])
        .map(async (el) => {
          if (workspace.pushPlatforms[el].credentials) {
            let firebaseApp: admin.app.App;

            try {
              firebaseApp = admin.app(account.id + ';;' + el);
            } catch (e: any) {
              if (e.code == 'app/no-app') {
                firebaseApp = admin.initializeApp(
                  {
                    credential: admin.credential.cert(
                      workspace.pushPlatforms[el].credentials
                    ),
                  },
                  `${account.id};;${el}`
                );
              } else {
                throw new HttpException(
                  `Error while using credentials for ${el}.`,
                  HttpStatus.FAILED_DEPENDENCY
                );
              }
            }

            const messaging = admin.messaging(firebaseApp);

            await messaging.send({
              token: token,
              notification: {
                title: `Laudspeaker ${el} test`,
                body: 'Testing push notifications',
              },
              android: {
                notification: {
                  sound: 'default',
                },
                priority: 'high',
              },
              apns: {
                headers: {
                  'apns-priority': '5',
                },
                payload: {
                  aps: {
                    badge: 1,
                    sound: 'default',
                  },
                },
              },
            });
            // await messaging.send({
            //   token: token,
            //   data: {
            //     title: `Laudspeaker ${el} test`,
            //     body: 'Testing push notifications',
            //     sound: 'default',
            //     badge: '1',
            //   },
            //   android: {
            //     priority: 'high'
            //   },
            //   apns: {
            //     headers: {
            //       'apns-priority': '5',
            //     },
            //     payload: {
            //       aps: {
            //         contentAvailable: true,
            //       },
            //     },
            //   },
            // });
          }
        })
    );
  }

  async sendFCMToken(
    auth: { account: Account; workspace: Workspaces },
    body: SendFCMDto,
    session: string
  ) {
    if (!body.type)
      throw new HttpException('No type given', HttpStatus.BAD_REQUEST);
    if (!body.token)
      throw new HttpException('No FCM token given', HttpStatus.BAD_REQUEST);

    const workspace = auth.workspace;

    let customer = await this.customersService.CustomerModel.findOne({
      _id: body.customerId,
      workspaceId: workspace.id,
    });

    if (!customer) {
      this.error('Customer not found', this.sendFCMToken.name, session);

      customer = await this.customersService.CustomerModel.create({
        isAnonymous: true,
        workspaceId: workspace.id,
      });
    }

    await this.customersService.CustomerModel.updateOne(
      { _id: customer._id },
      {
        [body.type === PushPlatforms.ANDROID
          ? 'androidDeviceToken'
          : 'iosDeviceToken']: body.token,
      }
    );

    return customer._id;
  }

  async identifyCustomer(
    auth: { account: Account; workspace: Workspaces },
    body: IdentifyCustomerDTO,
    session: string
  ) {
    if (!body.__PrimaryKey)
      throw new HttpException(
        'No Primary Key given',
        HttpStatus.NOT_ACCEPTABLE
      );

    if (!auth?.account || !body?.customerId) {
      return;
    }

    const workspace = auth.workspace;

    let customer = await this.customersService.CustomerModel.findOne({
      _id: body.customerId,
      workspaceId: workspace.id,
    });

    if (!customer) {
      this.error(
        'Invalid customer id. Creating new anonymous customer...',
        this.identifyCustomer.name,
        session
      );
      customer = await this.customersService.CustomerModel.create({
        _id: body.customerId, // Assuming body.customerId is a valid UUID and unique
        workspaceId: workspace.id,
        // Set other necessary fields for a new customer
        isAnonymous: true, // or false, as appropriate for your use case
        // Include any other properties you need to initialize for a new customer
      });
    }

    if (!customer.isAnonymous) {
      throw new HttpException(
        'Failed to identify: already identified',
        HttpStatus.NOT_ACCEPTABLE
      );
    }

    const primaryKey = await this.CustomerKeysModel.findOne({
      workspaceId: workspace.id,
      isPrimary: true,
    });

    const identifiedCustomer =
      await this.customersService.CustomerModel.findOne({
        workspaceId: workspace.id,
        [primaryKey.key]: body.__PrimaryKey,
      });

    if (identifiedCustomer) {
      await this.customersService.deleteEverywhere(customer._id);

      await customer.deleteOne();

      return identifiedCustomer._id;
    } else {
      await this.customersService.CustomerModel.findByIdAndUpdate(
        customer._id,
        {
          ...customer.toObject(),
          ...body.optionalProperties,
          //...uniqueProperties,
          [primaryKey.key]: body.__PrimaryKey,
          workspaceId: workspace.id,
          isAnonymous: false,
        }
      );
    }

    return customer._id;
  }

  async setCustomerProperties(
    auth: { account: Account; workspace: Workspaces },
    body: SetCustomerPropsDTO,
    session: string
  ) {
    if (!auth.account || !body.customerId) {
      return;
    }

    const workspace = auth.workspace;

    const customer = await this.customersService.CustomerModel.findOne({
      _id: body.customerId,
      workspaceId: workspace.id,
    });

    if (!customer || customer.isAnonymous) {
      this.error(
        'Invalid customer id. Please call identify first',
        this.setCustomerProperties.name,
        session
      );
      throw new HttpException(
        'Invalid customer id. Please call identify first',
        HttpStatus.NOT_FOUND
      );
    }

    await this.customersService.CustomerModel.findByIdAndUpdate(customer._id, {
      ...customer.toObject(),
      ...body.optionalProperties,
      workspaceId: workspace.id,
    });
  }

  async sendTestPushByCustomer(account: Account, body: CustomerPushTest) {
    const workspace = account.teams?.[0]?.organization?.workspaces?.[0];

    const hasConnected = Object.values(workspace.pushPlatforms).some(
      (el) => !!el
    );

    if (!hasConnected) {
      throw new HttpException(
        "You don't have platform's connected",
        HttpStatus.NOT_ACCEPTABLE
      );
    }

    const customer = await this.customersService.findById(
      account,
      body.customerId
    );

    if (!customer.androidDeviceToken && !customer.iosDeviceToken) {
      throw new HttpException(
        "Selected customer don't have androidDeviceToken nor iosDeviceToken.",
        HttpStatus.NOT_ACCEPTABLE
      );
    }

    await Promise.all(
      Object.entries(body.pushObject.platform)
        .filter(
          ([platform, isEnabled]) =>
            isEnabled && workspace.pushPlatforms[platform]
        )
        .map(async ([platform]) => {
          if (!workspace.pushPlatforms[platform]) {
            throw new HttpException(
              `Platform ${platform} is not connected.`,
              HttpStatus.NOT_ACCEPTABLE
            );
          }

          if (
            platform === PushPlatforms.ANDROID &&
            !customer.androidDeviceToken
          ) {
            this.logger.warn(
              `Customer ${body.customerId} don't have androidDeviceToken property to test push notification. Skipping.`
            );
            return;
          }

          if (platform === PushPlatforms.IOS && !customer.iosDeviceToken) {
            this.logger.warn(
              `Customer ${body.customerId} don't have iosDeviceToken property to test push notification. Skipping.`
            );
            return;
          }

          const settings: PlatformSettings = body.pushObject.settings[platform];
          let firebaseApp;
          try {
            firebaseApp = admin.app(account.id + ';;' + platform);
          } catch (e: any) {
            if (e.code == 'app/no-app') {
              firebaseApp = admin.initializeApp(
                {
                  credential: admin.credential.cert(
                    workspace.pushPlatforms[platform].credentials
                  ),
                },
                `${account.id};;${platform}`
              );
            } else {
              throw new HttpException(
                `Error while using credentials for ${platform}.`,
                HttpStatus.FAILED_DEPENDENCY
              );
            }
          }

          const { _id, workspaceId, workflows, ...tags } = customer.toObject();
          const filteredTags = cleanTagsForSending(tags);

          const messaging = admin.messaging(firebaseApp);

          try {
            await messaging.send({
              token:
                platform === PushPlatforms.ANDROID
                  ? customer.androidDeviceToken
                  : customer.iosDeviceToken,
              notification: {
                title: await this.tagEngine.parseAndRender(
                  settings.title,
                  filteredTags || {},
                  {
                    strictVariables: true,
                  }
                ),
                body: await this.tagEngine.parseAndRender(
                  settings.description,
                  filteredTags || {},
                  {
                    strictVariables: true,
                  }
                ),
              },
              android:
                platform === PushPlatforms.ANDROID
                  ? {
                      notification: {
                        sound: 'default',
                        imageUrl: settings?.image?.imageSrc,
                      },
                    }
                  : undefined,
              apns:
                platform === PushPlatforms.IOS
                  ? {
                      payload: {
                        aps: {
                          badge: 1,
                          sound: 'default',
                          category: settings.clickBehavior?.type,
                          contentAvailable: true,
                          mutableContent: true,
                        },
                      },
                      fcmOptions: {
                        imageUrl: settings?.image?.imageSrc,
                      },
                    }
                  : undefined,
              data: body.pushObject.fields.reduce((acc, field) => {
                acc[field.key] = field.value;
                return acc;
              }, {}),
            });
          } catch (e) {
            if (e instanceof Error) {
              throw new BadRequestException(e.message);
            }
          }
        })
    );
  }

  async batch(
    auth: { account: Account; workspace: Workspaces },
    MobileBatchDto: MobileBatchDto,
    session: string
  ) {
    return Sentry.startSpan({ name: 'EventsService.batch' }, async () => {
      let err: any;

      try {
        for (const thisEvent of MobileBatchDto.batch) {
          if (thisEvent.source === 'message') {
            const clickHouseRecord: ClickHouseMessage = {
              workspaceId: thisEvent.payload.workspaceID,
              stepId: thisEvent.payload.stepID,
              customerId: thisEvent.payload.customerID,
              templateId: String(thisEvent.payload.templateID),
              messageId: thisEvent.payload.messageID,
              event: thisEvent.event === '$delivered' ? 'delivered' : 'opened',
              eventProvider: ClickHouseEventProvider.PUSH,
              processed: false,
              createdAt: new Date().toISOString(),
            };
            await this.webhooksService.insertMessageStatusToClickhouse(
              [clickHouseRecord],
              session
            );
          } else {
            switch (thisEvent.event) {
              case '$identify':
                this.debug(
                  `Handling $identify event for correlationKey: ${thisEvent.correlationValue}`,
                  this.batch.name,
                  session,
                  auth.account.id
                );
                await this.handleIdentify(auth, thisEvent, session);
                break;
              case '$set':
                this.debug(
                  `Handling $set event for correlationKey: ${thisEvent.correlationValue}`,
                  this.batch.name,
                  session,
                  auth.account.id
                );
                await this.handleSet(auth, thisEvent, session);
                break;
              default:
                await this.customPayload(
                  { account: auth.account, workspace: auth.workspace },
                  thisEvent,
                  session
                );
                if (!thisEvent.correlationValue) {
                  throw new Error('correlation value is empty');
                }
                break;
            }
          }
        }
        //}
      } catch (e) {
        this.error(e, this.batch.name, session, auth.account.email);
        err = e;
      } finally {
        if (err) throw err;
      }
    });
  }

  async handleSet(
    auth: { account: Account; workspace: Workspaces },
    event: EventDto,
    session: string
  ) {
    const customerId = event.correlationValue;
    const updatePayload = event.payload;
    const workspaceId = auth.workspace.id;

    if (!customerId) {
      throw new Error('Customer ID is missing from the event');
    }

    // Retrieve all CustomerKeys for the workspace
    const customerKeys = await this.CustomerKeysModel.find({ workspaceId });

    const customersPrimaryKey = customerKeys.find((k) => k.isPrimary);

    if (!customersPrimaryKey) {
      this.debug(
        `Primary key not found for workspace --set a primary key first`,
        this.handleSet.name,
        session,
        auth.account.id
      );
      // Handle the absence of a primary key definition
      return;
    }

    const { customer, findType } = await this.findOrCreateCustomer(
      workspaceId,
      session,
      null,
      null,
      event
    );

    // Filter and validate the event payload against CustomerKeys
    // Exclude the primary key and 'other_ids' from updates
    const filteredPayload = {};
    Object.keys(event.payload).forEach((key) => {
      if (key !== customersPrimaryKey.key && key !== 'other_ids') {
        const customerKey = customerKeys.find((k) => k.key === key);
        if (
          customerKey &&
          this.isValidType(event.payload[key], customerKey.type)
        ) {
          filteredPayload[key] = event.payload[key];
        } else {
          console.warn(
            `Skipping update for key ${key}: Type mismatch or key not allowed.`
          );
        }
      }
    });

    // Update the customer with validated and filtered payload
    await this.customersService.CustomerModel.updateOne(
      { _id: customer._id },
      { $set: filteredPayload },
      { new: true }
    );

    await this.EventModel.create({
      event: event.event,
      workspaceId: workspaceId,
      payload: filteredPayload,
      //we should really standardize on .toISOString() or .toUTCString()
      //createdAt: new Date().toUTCString(),
      createdAt: new Date().toISOString(),
    });

    return customer._id;
  }

  async deduplication(customer, correlationValue) {
    // Step 1: Check if the customer's _id is not equal to the given correlation value
    if (customer._id.toString() !== correlationValue) {
      // Step 2: Update the customer's other_ids array with the correlation value if it doesn't already have it
      const updateResult = await this.customersService.CustomerModel.updateOne(
        {
          _id: customer._id,
          other_ids: { $ne: correlationValue }, // Ensures we don't add duplicates
        },
        {
          $push: { other_ids: correlationValue },
        }
      );

      //console.log('Update result:', updateResult);
    }

    // Additional Step: Retrieve the potential duplicate customer to compare deviceTokenSetAt for both device types
    const duplicateCustomer = await this.customersService.CustomerModel.findOne(
      {
        _id: correlationValue,
      }
    );

    // Determine which deviceTokenSetAt fields to compare
    const deviceTypes = ['ios', 'android'];
    const updateFields = {};

    for (const type of deviceTypes) {
      const tokenField = `${type}DeviceToken`;
      const setAtField = `${type}DeviceTokenSetAt`;

      // Check if the duplicate has a more recent deviceToken for each type
      if (
        duplicateCustomer &&
        duplicateCustomer[setAtField] &&
        (!customer[setAtField] ||
          duplicateCustomer[setAtField] > customer[setAtField])
      ) {
        // Prepare update object with the more recent deviceToken and its setAt timestamp
        updateFields[tokenField] = duplicateCustomer[tokenField];
        updateFields[setAtField] = duplicateCustomer[setAtField];
      }
    }

    // If there are fields to update (i.e., a more recent token was found), perform the update
    if (Object.keys(updateFields).length > 0) {
      await this.customersService.CustomerModel.updateOne(
        {
          _id: customer._id,
        },
        {
          $set: updateFields,
        }
      );
    }

    // Step 3: Delete any other customers that have an _id matching the correlation value
    const deleteResult = await this.customersService.CustomerModel.deleteMany({
      _id: correlationValue,
    });
  }

  // find keys that weren't marked as primary but may be used
  // as channels for sending messages (e.g. email, email_address,
  // phone, phone_number, etc..)
  async findMessageChannelsPrimaryKeys(workspaceId: string): Promise<string[]> {
    let keys = [];

    const customerKeys = await this.CustomerKeysModel.find({ workspaceId });

    // some of these fields are nested inside events (e.g. event.$fcm.iosDeviceToken)
    const rules = {
      email: ['^email', '^email_address'],
      phone: ['^phone', '^phone_number'],
      ios: ['^iosDeviceToken'],
      android: ['^androidDeviceToken'],
    };

    for (const customerKey of customerKeys) {
      if (
        customerKey.isPrimary ||
        (customerKey.type !== AttributeType.STRING &&
          customerKey.type !== AttributeType.EMAIL)
      )
        continue;

      let customKeyName = customerKey.key;

      for (const [channel, channelRules] of Object.entries(rules)) {
        let matchFound = false;

        for (const regexRule of channelRules) {
          let regex = new RegExp(regexRule, 'i');
          let result = regex.exec(customKeyName);

          if (result) {
            matchFound = true;
            break;
          }
        }

        if (matchFound) {
          keys.push(customKeyName);

          this.logger.log(
            `Matched channel ${channel} with customerKey ${customKeyName}`,
            this.findMessageChannelsPrimaryKeys.name
          );
          break;
        }
      }
    }

    return keys;
  }

  getFieldValueFromEvent(event: EventDto, fieldName: string): any {
    let objectToUse: any = event;

    if (fieldName == 'iosDeviceToken' || fieldName == 'androidDeviceToken')
      objectToUse = event.$fcm;

    return objectToUse[fieldName];
  }

  async findCustomer(
    workspaceId: string,
    session: string,
    primaryKeyValue?: string,
    primaryKeyName?: string,
    event?: EventDto
  ): Promise<{ customer: any; findType: number }> {
    let customer;
    let findType;
    const findConditions: Array<Object> = [];

    // Try to find by primary key if provided
    if (primaryKeyValue) {
      findConditions.push({
        [primaryKeyName]: primaryKeyValue,
        workspaceId,
      });
    }

    // try to find customers via message channel fields
    const messageChannelsKeys = await this.findMessageChannelsPrimaryKeys(
      workspaceId
    );
    // subset of the keys that are currently present in the event and used in findConditions
    const eventMessageChannelsKeys = [];

    for (const messageChannelsKey of messageChannelsKeys) {
      let eventFieldValue = this.getFieldValueFromEvent(
        event,
        messageChannelsKey
      );

      if (eventFieldValue) {
        findConditions.push({
          [messageChannelsKey]: eventFieldValue,
          workspaceId,
        });
        eventMessageChannelsKeys.push(messageChannelsKey);
      }
    }

    if (event.correlationValue) {
      findConditions.push(
        {
          _id: event.correlationValue,
          workspaceId,
        },
        {
          other_ids: event.correlationValue,
          workspaceId,
        }
      );
    }

    let customers = await this.customersService.CustomerModel.find({
      $or: findConditions,
    });

    for (let findTypeIndex = 1; findTypeIndex <= 4; findTypeIndex++) {
      for (let i = 0; i < customers.length; i++) {
        if (
          findTypeIndex == 1 &&
          primaryKeyName &&
          customers[i][primaryKeyName] == primaryKeyValue
        ) {
          findType = findTypeIndex;
          customer = customers[i];

          break;
        } else if (findTypeIndex == 2) {
          // find which field from the customer matches the event's
          for (const eventMessageField of eventMessageChannelsKeys) {
            let eventFieldValue = this.getFieldValueFromEvent(
              event,
              eventMessageField
            );

            if (eventFieldValue == customers[i][eventMessageField]) {
              findType = findTypeIndex;
              customer = customers[i];

              break;
            }
          }

          if (findType == findTypeIndex) break;
        } else if (
          findTypeIndex == 3 &&
          customers[i]._id == event.correlationValue
        ) {
          findType = findTypeIndex;
          customer = customers[i];

          break;
        } else if (
          findTypeIndex == 4 &&
          event.correlationValue &&
          customers[i].other_ids.includes(event.correlationValue.toString())
        ) {
          findType = findTypeIndex;
          customer = customers[i];

          break;
        }
      }

      if (findType == findTypeIndex) break;
    }

    // our conditions were not inclusive, something's wrong
    if (customers.length > 0 && !customer) {
      this.error(
        'MongoDB returned multiple customers but could not select one of them',
        this.findOrCreateCustomer.name,
        session
      );
    }

    return { customer, findType };
  }

  async findOrCreateCustomer(
    workspaceId: string,
    session: string,
    primaryKeyValue?: string,
    primaryKeyName?: string,
    event?: EventDto
  ): Promise<{ customer: any; findType: number }> {
    let { customer, findType } = await this.findCustomer(
      workspaceId,
      session,
      primaryKeyValue,
      primaryKeyName,
      event
    );

    // If customer still not found, create a new one
    if (!customer) {
      const upsertData = {
        $setOnInsert: {
          _id: event.correlationValue,
          workspaceId,
          createdAt: new Date(),
        },
      };

      if (primaryKeyValue && primaryKeyName) {
        upsertData.$setOnInsert[primaryKeyName] = primaryKeyValue;
        upsertData.$setOnInsert['isAnonymous'] = false;
      }

      try {
        customer = await this.customersService.CustomerModel.findOneAndUpdate(
          { _id: event.correlationValue, workspaceId },
          upsertData,
          { upsert: true, new: true }
        );
        findType = 100; // Set findType to 100 to indicate an upsert operation
      } catch (error: any) {
        // Check if the error is a duplicate key error
        if (error.code === 11000) {
          customer = await this.customersService.CustomerModel.findOne({
            _id: event.correlationValue,
            workspaceId,
          });
          findType = 200; // Optionally, set a different findType to indicate handling of a duplicate key error
        } else {
          this.error(error, this.findOrCreateCustomer.name, session);
        }
      }
    }

    if (event.$fcm) {
      const { iosDeviceToken, androidDeviceToken } = event.$fcm;
      const deviceTokenField = iosDeviceToken
        ? 'iosDeviceToken'
        : 'androidDeviceToken';
      const deviceTokenValue = iosDeviceToken || androidDeviceToken;
      const deviceTokenSetAtField = iosDeviceToken
        ? 'iosDeviceTokenSetAt'
        : 'androidDeviceTokenSetAt';
      if (customer[deviceTokenField] !== deviceTokenValue)
        customer = await this.customersService.CustomerModel.findOneAndUpdate(
          { _id: customer._id, workspaceId },
          {
            $set: {
              [deviceTokenField]: deviceTokenValue,
              [deviceTokenSetAtField]: new Date(), // Dynamically sets the appropriate deviceTokenSetAt field
            },
          },
          { new: true }
        );
    }

    return { customer, findType };
  }

  /*
   * Check to see if a customer found by primary key, if not search by _id
   *  if found by _id, update the user's primary key and fields
   *  If found by primary key update by fields
   */

  async handleIdentify(
    auth: { account: Account; workspace: Workspaces },
    event: EventDto, // Assuming EventDto has all the necessary fields including payload
    session: string
  ) {
    const primaryKeyValue = event.payload?.distinct_id; // Adjust based on your actual primary key field
    if (!primaryKeyValue) {
      this.warn(
        `No primary key provided in $identify event:${JSON.stringify(event)}`,
        this.handleIdentify.name,
        session,
        auth.account.email
      );
      return;
    }

    const workspaceId = auth.workspace.id;

    // Retrieve all CustomerKeys for the workspace to validate and filter updates
    const customerKeys = await this.CustomerKeysModel.find({ workspaceId });

    // Find the primary key among the CustomerKeys
    const customersPrimaryKey = customerKeys.find((k) => k.isPrimary);

    if (!customersPrimaryKey) {
      this.debug(
        `Primary key not found for workspace --go set a primary key`,
        this.handleIdentify.name,
        session,
        auth.account.id
      );
      // Handle the absence of a primary key definition
      return;
    }

    // Now you have the primary key's name and type
    const primaryKeyName = customersPrimaryKey.key;
    const primaryKeyType = customersPrimaryKey.type;

    // Check if the primary key value matches the expected type
    if (!this.isValidType(primaryKeyValue, primaryKeyType)) {
      this.debug(
        `Primary key value type in identify does not match expected type: ${primaryKeyType}`,
        this.handleIdentify.name,
        session,
        auth.account.id
      );
      // Handle the type mismatch as necessary
      return;
    }

    const { customer, findType } = await this.findOrCreateCustomer(
      workspaceId,
      session,
      primaryKeyValue,
      primaryKeyName,
      event
    );
    //check the customer does not have another primary key already if it does this is not supported right now
    if (findType == 3) {
      if (
        customer.primaryKeyName &&
        customer.primaryKeyName !== primaryKeyValue
      ) {
        this.debug(
          `found customers primary key: ${customer.primaryKeyName} does not match event primary key`,
          this.handleIdentify.name,
          session,
          auth.account.id
        );
        //console.log("found customers primary key", customer.primaryKeyName, "does not match event primary key", primaryKeyValue )
        return;
      }
    }

    if (customer._id !== event.correlationValue) {
      await this.deduplication(customer, event.correlationValue);
    }

    // Filter and validate the event payload against CustomerKeys, with special handling for distinct_id and $anon_distinct_id
    const filteredPayload = {};
    const otherIdsUpdates = [];

    Object.keys(event.payload).forEach((key) => {
      if (key === 'distinct_id') {
        // Handle distinct_id: Check if it matches the primary key type and set customer's primary key
        const isValid = this.isValidType(event.payload[key], primaryKeyType); // Assume primaryKeyType is determined earlier
        if (isValid) {
          filteredPayload[primaryKeyName] = event.payload[key]; // Or handle updating the primary key as needed
        } else {
          //console.warn(`Skipping update for distinct_id: Type mismatch.`);
        }
      } else if (key === '$anon_distinct_id') {
        // Check and add $anon_distinct_id to other_ids if not already present and valid and not equal to the customer's own _id
        const isValid = this.isValidType(
          event.payload[key],
          AttributeType.STRING
        ); // Assuming $anon_distinct_id should always be a string
        const anonId = event.payload[key];
        if (
          isValid &&
          !customer.other_ids.includes(event.payload[key]) &&
          customer._id !== anonId
        ) {
          otherIdsUpdates.push(anonId);
        } else {
        }
      } else {
        // Handle other keys normally
        const customerKey = customerKeys.find((k) => k.key === key);
        if (
          customerKey &&
          this.isValidType(event.payload[key], customerKey.type)
        ) {
          filteredPayload[key] = event.payload[key];
        } else {
        }
      }
    });

    // Assuming the merging logic or creation of a new customer has been handled before this
    // Update the customer with validated and filtered payload, including handling of arrays
    await this.customersService.CustomerModel.updateOne(
      { _id: customer._id },
      {
        $set: filteredPayload,
        ...(otherIdsUpdates.length > 0 && {
          $addToSet: { other_ids: { $each: otherIdsUpdates } },
        }),
      },
      { upsert: true }
    );

    await this.EventModel.create({
      event: event.event,
      workspaceId: workspaceId,
      payload: filteredPayload,
      createdAt: new Date().toISOString(),
    });

    return customer._id;
  }

  async handleFCM(
    auth: { account: Account; workspace: Workspaces },
    event: EventDto,
    session: string
  ) {
    // Extract device tokens from the event payload
    const { iosDeviceToken, androidDeviceToken } = event.$fcm;
    const customerId = event.correlationValue; // Or distinct_id, assuming they are meant to represent the same identifier

    // Determine which device token is provided
    const deviceTokenField = iosDeviceToken
      ? 'iosDeviceToken'
      : 'androidDeviceToken';
    const deviceTokenValue = iosDeviceToken || androidDeviceToken;
    const deviceTokenSetAtField = iosDeviceToken
      ? 'iosDeviceTokenSetAt'
      : 'androidDeviceTokenSetAt';

    // Ensure a device token and customerId are provided
    if (!deviceTokenValue || !customerId) {
      this.debug(
        `Missing device token or customerId in FCM event`,
        this.handleFCM.name,
        session,
        auth.account.id
      );
      // Optionally, handle the error condition here
      return;
    }

    // Retrieve the customer based on customerId
    const workspaceId = auth.workspace.id;
    const { customer, findType } = await this.findOrCreateCustomer(
      workspaceId,
      session,
      null,
      null,
      event
    );

    // Update the customer with the provided device token
    const updatedCustomer =
      await this.customersService.CustomerModel.findOneAndUpdate(
        { _id: customer._id, workspaceId },
        {
          $set: {
            [deviceTokenField]: deviceTokenValue,
            [deviceTokenSetAtField]: new Date(), // Dynamically sets the appropriate deviceTokenSetAt field
          },
        },
        { new: true }
      );

    this.debug(
      `FCM event processed for customer ${customerId}, Device Token Field: ${deviceTokenField}`,
      this.handleFCM.name,
      session,
      auth.account.id
    );

    return updatedCustomer;
  }

  isValidType(value: any, type: AttributeType): boolean {
    switch (type) {
      case AttributeType.STRING:
        return typeof value === 'string';
      case AttributeType.NUMBER:
        return typeof value === 'number';
      case AttributeType.BOOLEAN:
        return typeof value === 'boolean';
      case AttributeType.EMAIL:
        // Simple regex for email validation, consider a library for production use
        return typeof value === 'string' && /^\S+@\S+\.\S+$/.test(value);
      case AttributeType.DATE:
      case AttributeType.DATE_TIME:
        // Check if it's a valid Date
        return !isNaN(Date.parse(value));
      case AttributeType.ARRAY:
        return Array.isArray(value);
      case AttributeType.OBJECT:
        return (
          typeof value === 'object' && !Array.isArray(value) && value !== null
        );
      default:
        return false;
    }
  }
}

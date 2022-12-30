import {
  HttpException,
  Inject,
  Injectable,
  LoggerService,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Like, Repository } from 'typeorm';
import { Audience } from './entities/audience.entity';
import { CreateAudienceDto } from './dto/create-audience.dto';
import { UpdateAudienceDto } from './dto/update-audience.dto';
import { Account } from '../accounts/entities/accounts.entity';
import { AddTemplateDto } from './dto/add-template.dto';
import { CustomerDocument } from '../customers/schemas/customer.schema';
import { Template } from '../templates/entities/template.entity';
import Errors from '../../shared/utils/errors';
import { TemplatesService } from '../templates/templates.service';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { from } from 'form-data';
import { Job } from 'bull';
import { CustomersService } from '../customers/customers.service';
import { checkInclusion } from './audiences.helper';
import { Stats } from './entities/stats.entity';
import { Workflow } from '../workflows/entities/workflow.entity';
import { EventDto } from '../events/dto/event.dto';

@Injectable()
export class AudiencesService {
  /**
   * Audience service constructor; this class is the only class that should
   * be using the Audiences repository (`Repository<Audience>`) directly.
   * @class
   */
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
    @InjectRepository(Audience)
    public audiencesRepository: Repository<Audience>,
    @InjectRepository(Stats) private statsRepository: Repository<Stats>,
    @InjectRepository(Workflow)
    private workflowRepository: Repository<Workflow>,
    @Inject(TemplatesService) public templatesService: TemplatesService
  ) {}

  /**
   * Find all audiences that belong to a given account. If
   * not found, returns empty array
   *
   * @param account - The owner of the audiences
   *
   */
  findAll(account: Account): Promise<Audience[]> {
    return this.audiencesRepository.findBy({
      owner: { id: account.id },
    });
  }

  /**
   * Returns the first audience belonging to the given account with
   * the sepcified 'name' field. If not found, returns null
   *
   * @param account - The owner of the audience
   * @param name - name used for lookup
   *
   */
  findByName(account: Account, name: string): Promise<Audience | null> {
    return this.audiencesRepository.findOneBy({
      owner: { id: account.id },
      name: name,
    });
  }

  /**
   * Returns the first audience belonging to the given account with
   * the sepcified 'id'. If not found, returns null
   *
   * @param account - The owner of the audience
   * @param id - ID used for lookup
   *
   */
  findOne(account: Account, id: string): Promise<Audience> {
    return this.audiencesRepository.findOneBy({
      owner: { id: account.id },
      id: id,
    });
  }

  /**
   * Add a new audience. Secondary (isPrimary=false) audiences cannot
   * have inclusion criteria or resources, and they cannot be dynamic.
   *
   * @remarks
   * If either the audience is not found or the template is not found
   * this function has no effect. If the template is already part of that audience
   * this function has no effect.
   *
   * @param account - The owner of the audience
   * @param updateAudienceDto - DTO with the updated information
   *
   */
  async insert(
    account: Account,
    createAudienceDto: CreateAudienceDto
  ): Promise<Audience> {
    const { name, isPrimary, description, templates } = createAudienceDto;
    try {
      const resp = await this.audiencesRepository.save({
        customers: [],
        name,
        isPrimary,
        description,
        templates: templates || [],
        owner: { id: account.id },
      });
      const stats = this.statsRepository.create({ audience: resp });
      await this.statsRepository.save(stats);
      return resp;
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Edit the description, name, resources, dynamicism, or inclusion criteria of
   * an audience
   *
   * @remarks
   * If either the audience is not found or the template is not found
   * this function has no effect. If the template is already part of that audience
   * this function has no effect.
   *
   * @param account - The owner of the audience
   * @param updateAudienceDto - DTO with the updated information
   *
   */
  async update(
    account: Account,
    updateAudienceDto: UpdateAudienceDto
  ): Promise<void> {
    let audience: Audience; // The found audience
    try {
      audience = await this.audiencesRepository.findOneBy({
        owner: { id: account.id },
        id: updateAudienceDto.id,
        isEditable: true,
      });

      // const workflows = await this.workflowRepository.find({
      //   where: {
      //     audiences: Like('%' + audience.id + '%'),
      //   },
      // });

      // if (workflows.some((wkf) => wkf.isActive)) {
      //   throw new HttpException('This workflow is active', 400);
      // }

      this.logger.debug('Found audience: ' + audience.id);
      if (!audience) {
        this.logger.error('Error: Audience not found');
        return Promise.reject(new Error(Errors.ERROR_DOES_NOT_EXIST));
      }
    } catch (err) {
      this.logger.error('Error: ' + err);
      return Promise.reject(err);
    }
    try {
      await this.audiencesRepository.update(
        { owner: { id: account.id }, id: updateAudienceDto.id },
        {
          description: updateAudienceDto.description,
          name: updateAudienceDto.name,
          resources: audience.isPrimary
            ? updateAudienceDto.resources
            : undefined,
        }
      );
      this.logger.debug('Updated audience: ' + audience.id);
    } catch (err) {
      this.logger.error('Error: ' + err);
      return Promise.reject(err);
    }
    return;
  }

  /**
   * Sets audience.isEditable to false.
   *
   * @remarks
   * Once an audience's isEditable field is set to false, only the customers
   * array of the audience entity can be modified, and only the moveCustomer
   * method can modify it. After freezing there is no way to thaw.
   *
   * @param account - The account entity that the audience belongs to
   * @param id - The audience ID to freeze
   *
   */
  async freeze(account: Account, id: string): Promise<Audience> {
    let found: Audience, ret: Audience;
    try {
      found = await this.audiencesRepository.findOneBy({
        owner: { id: account.id },
        id: id,
      });
      this.logger.debug('Found audience to freeze: ' + found.id);
    } catch (err) {
      this.logger.error('Error: ' + err);
      return Promise.reject(err);
    }
    try {
      ret = await this.audiencesRepository.save({
        ...found,
        isEditable: false,
      });
      this.logger.debug('Froze audience: ' + ret.id);
    } catch (err) {
      this.logger.error('Error: ' + err);
      return Promise.reject(err);
    }
    return ret;
  }

  /**
   * Moves a customer ID from one audience entity to another.
   *
   * @remarks
   * If either fromAud or toAud are falsy, this functions as a way
   * to remove/add customers from audiences. The audience must no longer
   * be editable. If the toAud is primary and static, the customer will
   * not be moved to that audience.
   *
   * @param fromAud - The audience entity to remove the customer ID from
   * @param toAud - The audience entity to add the customer ID to
   * @param customerId - The customer ID to add/remove
   *
   */
  async moveCustomer(
    account: Account,
    from: string | null | undefined,
    to: string | null | undefined,
    customerId: string,
    event: EventDto
  ): Promise<{ jobIds: (string | number)[]; templates: Template[] }> {
    let index = -1; // Index of the customer ID in the fromAud.customers array
    const jobIds: (string | number)[] = [];
    let jobId: string | number;
    let fromAud: Audience, toAud: Audience;
    const templates: Template[] = [];

    if (from) {
      try {
        fromAud = await this.findOne(account, from);
      } catch (err) {
        this.logger.error('Error: ' + err);
        return Promise.reject(err);
      }
    }
    if (to) {
      try {
        toAud = await this.findOne(account, to);
      } catch (err) {
        this.logger.error('Error: ' + err);
        return Promise.reject(err);
      }
    }

    if (fromAud?.customers?.length) {
      index = fromAud?.customers?.indexOf(customerId);
      this.logger.debug(
        'Index of customer ' + customerId + ' inside of from: ' + index
      );
    }
    if (fromAud && !fromAud.isEditable && index > -1) {
      try {
        this.logger.debug(
          'From customers before: ' + fromAud?.customers?.length
        );
        fromAud?.customers?.splice(index, 1);
        await this.audiencesRepository.update(
          { id: fromAud.id, isEditable: false },
          {
            customers: fromAud?.customers,
          }
        );
        this.logger.debug(
          'From customers after: ' + fromAud?.customers?.length
        );
      } catch (err) {
        this.logger.error('Error: ' + err);
        return Promise.reject(err);
      }
    }
    if (toAud && !toAud.isEditable) {
      try {
        this.logger.debug('To before: ' + toAud?.customers?.length);
        const saved = await this.audiencesRepository.save(
          //{ id: toAud.id, isEditable: false },
          {
            ...toAud,
            customers: [...toAud?.customers, customerId],
          }
        );
        this.logger.debug('To after: ' + saved?.customers?.length);
      } catch (err) {
        this.logger.error('Error: ' + err);
        return Promise.reject(err);
      }

      if (
        account.emailProvider === 'free3' &&
        account.customerId !== customerId &&
        toAud?.templates?.length
      ) {
        const data = await this.templatesService.templatesRepository.find({
          where: {
            owner: { id: account.id },
            type: 'email',
            id: In(toAud?.templates),
          },
        });
        if (data.length > 0) {
          this.logger.debug(
            'ToAud templates before template skip: ',
            toAud.templates
          );
          const dataIds = data.map((el2) => String(el2.id));
          toAud.templates = toAud.templates.filter(
            (el) => !dataIds.includes(String(el))
          );
          this.logger.debug(
            'ToAud templates after template skip: ',
            toAud.templates
          );
          this.logger.warn(
            'Templates: [' +
              dataIds.join(',') +
              "] was skipped to send because test mail's can't be sent to external account."
          );
        }
      }

      if (toAud?.templates?.length) {
        for (
          let templateIndex = 0;
          templateIndex < toAud?.templates?.length;
          templateIndex++
        ) {
          try {
            jobId = await this.templatesService.queueMessage(
              account,
              toAud.templates[templateIndex],
              customerId,
              event,
              toAud.id
            );
            templates.push(
              await this.templatesService.templatesRepository.findOneBy({
                id: toAud.templates[templateIndex],
              })
            );
            this.logger.debug('Queued Message');
            jobIds.push(jobId);
          } catch (err) {
            this.logger.error('Error: ' + err);
            return Promise.reject(err);
          }
        }
      }
    }
    return Promise.resolve({ jobIds, templates });
  }

  /**
   * Moves an array of customer documents from one audience to another.
   *
   * @remarks
   * Calls moveCustomer under the hood, this is just a convenience method
   *
   * @param fromAud - The audience entity to remove the customers from
   * @param toAud - The audience entity to add the customers to
   * @param customers - The array of customer documents to add/remove
   *
   */
  async moveCustomers(
    account: Account,
    fromAud: Audience | null | undefined,
    toAud: Audience | null | undefined,
    customers: CustomerDocument[],
    event: EventDto
  ): Promise<(string | number)[]> {
    let jobIds: (string | number)[] = [];
    for (let index = 0; index < customers?.length; index++) {
      try {
        const { jobIds: jobIdArr } = await this.moveCustomer(
          account,
          fromAud?.id,
          toAud?.id,
          customers[index].id,
          event
        );
        jobIds = [...jobIdArr, ...jobIds];
      } catch (err) {
        this.logger.error('Error: ' + err);
        return Promise.reject(err);
      }
    }
    // TODO: remove
    console.warn("jobId's ==============\n", jobIds);
    return Promise.resolve(jobIds);
  }
}

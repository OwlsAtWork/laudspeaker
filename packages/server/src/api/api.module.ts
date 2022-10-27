import { Inject, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { CustomersModule } from './customers/customers.module';
import { EmailModule } from './email/email.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { AudiencesModule } from './audiences/audiences.module';
import { EventsModule } from './events/events.module';
import { TemplatesModule } from './templates/templates.module';
import { SlackModule } from './slack/slack.module';
import { Account } from './accounts/entities/accounts.entity';
import { AuthService } from './auth/auth.service';
import { CustomersService } from './customers/customers.service';
import { CreateCustomerDto } from './customers/dto/create-customer.dto';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Workflow } from './workflows/entities/workflow.entity';
import { Repository } from 'typeorm';
import { Template } from './templates/entities/template.entity';
import { Audience } from './audiences/entities/audience.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, Template, Audience]),
    AccountsModule,
    AuthModule,
    CustomersModule,
    EmailModule,
    WorkflowsModule,
    AudiencesModule,
    EventsModule,
    TemplatesModule,
    SlackModule,
  ],
})
export class ApiModule {
  constructor(
    @InjectRepository(Workflow)
    private workflowsRepository: Repository<Workflow>,
    @InjectRepository(Audience)
    private audienceRepository: Repository<Audience>,
    @InjectRepository(Template)
    private templateRepository: Repository<Template>,
    private readonly authService: AuthService,
    private readonly customersService: CustomersService
  ) {
    if (process.env.NODE_ENV === 'development') {
      this.generateUsersForTests();
    }
  }

  /**
   * generateUsersForTests
   * generate user which will be used for testing event hitting and sending messages
   */
  private async generateUsersForTests() {
    try {
      const userCreated = await this.authService.repository.findOne({
        where: {
          apiKey: 'dowkp5HD51tdEL4U09kFW2MKj3hCyT664Ol40000',
        },
      });

      if (userCreated?.id) {
        await this.authService.repository.remove([userCreated]);
      }

      const user = new Account();

      user.firstName = 'TFNameUser';
      user.lastName = 'TLNameUser';
      user.email = 'testmail@gmail.com';
      user.password = this.authService.helper.encodePassword('00000000');
      user.apiKey = 'dowkp5HD51tdEL4U09kFW2MKj3hCyT664Ol40000';
      user.slackTeamId = ['T01U4FFQ796'];
      user.sendingEmail = 'semail';
      user.sendingName = 'sname';
      user.sendingDomain =
        'sandboxd7ae9069e24b4e8dbb5ca3ba7d4bed04.mailgun.org';
      user.mailgunAPIKey = 'e52ef0112c0c7394b273ba3d3e25474c-4dd50799-4a315eeb';
      user.expectedOnboarding = ['Slack'];
      user.currentOnboarding = ['Slack'];
      user.onboarded = true;

      const ret = await this.authService.repository.save(user);
      await this.authService.repository.update(
        { id: ret.id },
        {
          id: '1000',
        }
      );
      ret.id = '1000';

      await this.workflowsRepository.delete({ ownerId: '1000' });
      await this.templateRepository.delete({ ownerId: '1000' });
      await this.audienceRepository.delete({ ownerId: '1000' });

      await this.customersService.CustomerModel.findOneAndRemove({
        ownerId: '1000',
      });

      const sanitizedMember = new CreateCustomerDto();

      sanitizedMember.slackName = 'mahamad';
      sanitizedMember.slackId = 'U04323JCL5A'; // for test purpose change it to your UID here and on the frontend -> cypress/fixture/credentials.json -> slackUid
      sanitizedMember.slackRealName = 'Mahamad Charawi';
      sanitizedMember.slackTeamId = ['T01U4FFQ796'];
      sanitizedMember.slackTimeZone = -25200;
      sanitizedMember.slackEmail = 'mahamad@trytachyon.com';
      sanitizedMember.email = process.env.SENDING_TO_TEST_EMAIL;
      sanitizedMember.slackDeleted = false;
      sanitizedMember.slackAdmin = true;
      sanitizedMember.slackTeamMember = true;

      await this.customersService.create(ret, sanitizedMember);
    } catch (error) {
      console.error('Error generating test users:', error);
    }
  }
}

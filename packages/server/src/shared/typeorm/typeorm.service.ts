import { TypeOrmOptionsFactory, TypeOrmModuleOptions } from '@nestjs/typeorm';

export class TypeOrmConfigService implements TypeOrmOptionsFactory {
  public createTypeOrmOptions(): TypeOrmModuleOptions {
    return {
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: process.env.DATABASE_PORT ? +process.env.DATABASE_PORT : 5432,
      database: process.env.DATABASE_NAME || 'laudspeaker',
      ssl: process.env.DATABASE_SSL === 'true' ? true : false,
      username: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      entities: ['dist/**/*.entity.{ts,js}'],
      migrations: ['dist/**/migrations/*.{ts,js}'],
      migrationsTableName: 'typeorm_migrations',
      logger: 'advanced-console',
      logging: ['warn', 'error'],
      subscribers: [],
      synchronize: process.env.SYNCHRONIZE == 'true', // never use TRUE in production!
      autoLoadEntities: true,
      maxQueryExecutionTime: 2000,
      extra: {
        max: 100,
        options:
          '-c lock_timeout=240000ms -c statement_timeout=240000ms -c idle_in_transaction_session_timeout=240000ms',
      },
      // migrationsRun: true,
    };
  }
}

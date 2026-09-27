import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.listen(3000);
}

void bootstrap();

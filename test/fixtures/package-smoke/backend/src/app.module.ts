import { Module, Controller, Get } from '@nestjs/common';
@Controller('health')
export class HealthController {
  @Get()
  check() { return { ok: true }; }
}
@Module({ controllers: [HealthController] })
export class AppModule {}

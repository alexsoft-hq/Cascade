import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  @Version(VERSION_NEUTRAL)
  public check() {
    return { ok: true };
  }
}

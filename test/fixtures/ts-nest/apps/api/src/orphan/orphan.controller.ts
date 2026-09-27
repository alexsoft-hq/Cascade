import { Controller, Get } from '@nestjs/common';

// No module lists this controller, so the application never serves it.
@Controller('orphan')
export class OrphanController {
  @Get()
  public nothing() {
    return null;
  }
}

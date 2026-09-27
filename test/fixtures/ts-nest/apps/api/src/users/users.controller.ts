import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  public constructor(private readonly usersService: UsersService) {}

  @Get()
  public list() {
    return this.usersService.list();
  }

  @Get(':id')
  public one(@Param('id') id: string) {
    return this.usersService.one(id);
  }

  @Post()
  public create(@Body() body: { email: string; name: string }) {
    return this.usersService.create(body.email, body.name);
  }
}

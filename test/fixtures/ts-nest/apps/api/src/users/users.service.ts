import { Injectable } from '@nestjs/common';
import { normalizeEmail } from '@fixture/common/email';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  public constructor(private readonly prisma: PrismaService) {}

  public list() {
    return this.prisma.user.findMany({ select: { id: true, email: true } });
  }

  public async one(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { name: true } });
    const posts = await this.prisma.post.findMany({ where: { authorId: id }, select: { title: true } });
    return { user, posts };
  }

  public create(email: string, name: string) {
    return this.prisma.user.create({ data: { email: normalizeEmail(email), name } });
  }
}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ContainersController } from './containers.controller';
import { ContainersService } from './containers.service';

@Module({
  imports: [PrismaModule],
  controllers: [ContainersController],
  providers: [ContainersService],
})
export class ContainersModule {}

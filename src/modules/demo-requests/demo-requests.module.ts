import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdminDemoController,
  PublicDemoController,
} from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';
import { DemoReminderWorker } from './demo-reminder.worker';
import { DemoRequest } from './entities/demo-request.entity';
import { DemoRequestNote } from './entities/demo-request-note.entity';

@Module({
  imports: [TypeOrmModule.forFeature([DemoRequest, DemoRequestNote])],
  controllers: [PublicDemoController, AdminDemoController],
  providers: [DemoRequestsService, DemoReminderWorker],
  exports: [DemoRequestsService],
})
export class DemoRequestsModule {}

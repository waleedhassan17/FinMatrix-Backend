import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agency } from './entities/agency.entity';
import { AgenciesService } from './agencies.service';
import { AgenciesController } from './agencies.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Agency])],
  providers: [AgenciesService],
  controllers: [AgenciesController],
  exports: [AgenciesService],
})
export class AgenciesModule {}

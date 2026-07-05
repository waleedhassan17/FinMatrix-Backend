import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from './storage.service';
import { StoredFileRecord } from './stored-file.entity';

@Global()
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([StoredFileRecord])],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}

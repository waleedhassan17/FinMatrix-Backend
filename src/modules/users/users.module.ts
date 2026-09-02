import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { ManagedCredential } from './entities/managed-credential.entity';
import { UsersService } from './users.service';
import { CredentialVaultService } from './credential-vault.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, ManagedCredential])],
  providers: [UsersService, CredentialVaultService],
  // CredentialVaultService is shared: both /settings/users and
  // /delivery-personnel issue owner-managed passwords and read them back.
  exports: [UsersService, CredentialVaultService, TypeOrmModule],
})
export class UsersModule {}

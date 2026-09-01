import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalRequest } from './entities/approval-request.entity';
import { ApprovalRequestsService } from './approval-requests.service';

/**
 * The half of the approval engine that domain modules can safely import.
 *
 * The gate lives in the OWNING controllers — inventory, bills, purchase orders
 * and so on each decide between "post now" (owner) and "file a request"
 * (staff) — so each of those modules needs to inject something that can file
 * one. Filing needs no domain service: it writes a single row.
 *
 * Keeping that capability here, with no domain imports, is what stops the
 * dependency cycle. ApprovalsModule imports every domain module in order to
 * dispatch; if the domain modules had to import IT back for the gate, every
 * one of those edges would need forwardRef(). They import this instead.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApprovalRequest])],
  providers: [ApprovalRequestsService],
  exports: [ApprovalRequestsService, TypeOrmModule],
})
export class ApprovalsCoreModule {}

import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth(): {
    status: 'ok';
    service: string;
    version: string;
    uptimeSeconds: number;
    timestamp: string;
  } {
    return {
      status: 'ok',
      service: 'finmatrix-backend',
      version: process.env.npm_package_version ?? '0.0.1',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

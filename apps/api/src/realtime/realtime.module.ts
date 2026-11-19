import { Module } from '@nestjs/common';
import { LiveGateway } from './gateway.js';

@Module({ providers: [LiveGateway] })
export class RealtimeModule {}

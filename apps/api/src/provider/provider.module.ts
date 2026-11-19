import { Module } from '@nestjs/common';
import { ProviderController } from './provider.controller.js';

@Module({ controllers: [ProviderController] })
export class ProviderModule {}

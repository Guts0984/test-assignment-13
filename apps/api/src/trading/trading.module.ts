import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller.js';

@Module({ controllers: [TradingController] })
export class TradingModule {}

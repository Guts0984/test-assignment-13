import { Module } from '@nestjs/common';
import { SellerController } from './seller.controller.js';

@Module({ controllers: [SellerController] })
export class SellerModule {}

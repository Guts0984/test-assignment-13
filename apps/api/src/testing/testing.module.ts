import { Module } from '@nestjs/common';
import { TestClockController } from './testing.controller.js';

@Module({ controllers: [TestClockController] })
export class TestingModule {}

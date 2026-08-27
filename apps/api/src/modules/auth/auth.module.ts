import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ZALO_AUTH_PROVIDER } from './auth.constants';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { MockZaloAuthProvider } from './providers/mock-zalo-auth.provider';
import { RealZaloAuthProvider } from './providers/real-zalo-auth.provider';
import { ZaloLocationProvider } from './providers/zalo-location.provider';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET')?.trim();
        if (!secret) throw new Error('JWT_SECRET is required and cannot be empty');
        return {
          secret,
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    MockZaloAuthProvider,
    RealZaloAuthProvider,
    ZaloLocationProvider,
    {
      provide: ZALO_AUTH_PROVIDER,
      inject: [ConfigService, MockZaloAuthProvider, RealZaloAuthProvider],
      useFactory: (
        config: ConfigService,
        mockProvider: MockZaloAuthProvider,
        realProvider: RealZaloAuthProvider,
      ) => {
        const mode = config.get<string>('ZALO_AUTH_MODE')?.trim();
        const environment = config.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development');
        if (environment === 'production' && mode !== 'real') {
          throw new Error('ZALO_AUTH_MODE=real is required in production');
        }
        if (mode === 'real') return realProvider;
        if (environment !== 'development' && environment !== 'test') {
          throw new Error('Mock Zalo auth is only allowed in development/test');
        }
        return mockProvider;
      },
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AuthModule {}

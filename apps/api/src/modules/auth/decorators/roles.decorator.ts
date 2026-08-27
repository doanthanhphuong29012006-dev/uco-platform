import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { ROLES_KEY } from '../auth.constants';

export const Roles = (...roles: Role[]): ReturnType<typeof SetMetadata> => SetMetadata(ROLES_KEY, roles);

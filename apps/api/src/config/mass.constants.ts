import type { ConfigService } from '@nestjs/config';
import { DEFAULT_DENSITY_KG_PER_LITER } from '@eco-oil/shared-types';

export const DENSITY_KG_PER_LITER = DEFAULT_DENSITY_KG_PER_LITER;

export function getDensityKgPerLiter(config: ConfigService): number {
  const configured = config.get<string>('DENSITY_KG_PER_LITER');
  const density = configured === undefined || configured.trim() === '' ? DENSITY_KG_PER_LITER : Number(configured);
  if (!Number.isFinite(density) || density <= 0) {
    throw new Error('DENSITY_KG_PER_LITER must be a positive number');
  }
  return density;
}

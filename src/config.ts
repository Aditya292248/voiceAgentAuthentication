// The only module that reads process.env. Everything else receives a typed Config.
import { z } from 'zod';

// E.164: '+', then 7 to 15 digits, no leading zero in the country code.
const E164 = /^\+[1-9]\d{6,14}$/;

const SubAccount = z
  .string()
  .transform((entry) => {
    const [id = '', ...rest] = entry.split(':');
    return { id: id.trim(), ownerName: rest.join(':').trim() };
  })
  .pipe(
    z.object({
      id: z.string().min(1, 'missing sub-account id before ":"'),
      ownerName: z.string().min(1, 'missing owner name after ":"'),
    }),
  );

const SubAccounts = z
  .string({ error: 'required' })
  .transform((raw) =>
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(SubAccount).min(1, 'expected at least one "id:OwnerName" entry'));

// Messages never include the input value: it may be a secret or a phone number.
const EnvSchema = z
  .object({
    AGENTPHONE_API_KEY: z.string({ error: 'required' }).min(1, 'must not be empty'),
    MY_NUMBER: z.string({ error: 'required' }).regex(E164, 'must be E.164, e.g. +12025550123'),
    SUB_ACCOUNTS: SubAccounts,
    SIGNING_KEY_PATH: z.string().min(1, 'must not be empty if set').optional(),
    PORT: z.coerce
      .number({ error: 'must be a number' })
      .int('must be an integer')
      .min(1, 'must be 1-65535')
      .max(65535, 'must be 1-65535')
      .default(3000),
  })
  .transform((env) => ({
    apiKey: env.AGENTPHONE_API_KEY,
    myNumber: env.MY_NUMBER,
    subAccounts: env.SUB_ACCOUNTS,
    signingKeyPath: env.SIGNING_KEY_PATH,
    port: env.PORT,
  }));

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Pure: validates an env-like object, throwing ConfigError that lists every problem. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
  );
  throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
}

/** Reads process.env once at startup; on bad config, prints the problems and exits 1. */
export function loadConfig(): Config {
  try {
    return parseConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`${err.message}\nSee .env.example.\n`);
    process.exit(1);
  }
}

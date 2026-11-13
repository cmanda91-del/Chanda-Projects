// Central configuration. Every value can be overridden with an environment variable.
const env = process.env;
const int = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: int(env.PORT, 3000),
  isProd: env.NODE_ENV === 'production',
  dataDir: env.DATA_DIR || './data',
  appName: env.APP_NAME || 'ZedPrep',
  appUrl: env.APP_URL || '',
  sessionSecret: env.SESSION_SECRET || '',
  adminPhone: env.ADMIN_PHONE || '',

  // AI provider: set ANTHROPIC_API_KEY or OPENAI_API_KEY. With neither, the app runs in demo mode.
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  openaiKey: env.OPENAI_API_KEY || '',
  openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',

  // Lenco mobile money collections
  lencoKey: env.LENCO_API_KEY || '',
  lencoBaseUrl: (env.LENCO_BASE_URL || 'https://api.lenco.co/access/v2').replace(/\/$/, ''),

  // Free tier allowances (per day, Lusaka time)
  freeQuestionsPerDay: int(env.FREE_QUESTIONS_PER_DAY, 10),
  freeTutorPerDay: int(env.FREE_TUTOR_PER_DAY, 5),
  // Fair-use caps for paying learners (protects AI spend)
  paidQuestionsPerDay: int(env.PAID_QUESTIONS_PER_DAY, 200),
  paidTutorPerDay: int(env.PAID_TUTOR_PER_DAY, 60),
};

// Plans: prices in Kwacha. Override with PRICE_WEEKLY / PRICE_MONTHLY / PRICE_TERM.
export const PLANS = {
  weekly: { id: 'weekly', name: 'Weekly', days: 7, price: int(env.PRICE_WEEKLY, 20) },
  monthly: { id: 'monthly', name: 'Monthly', days: 30, price: int(env.PRICE_MONTHLY, 60) },
  term: { id: 'term', name: 'Full term (3 months)', days: 90, price: int(env.PRICE_TERM, 150) },
};

export function aiProvider() {
  if (config.anthropicKey) return 'anthropic';
  if (config.openaiKey) return 'openai';
  return 'demo';
}

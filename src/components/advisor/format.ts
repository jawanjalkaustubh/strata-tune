const GIB = 1024 ** 3;

export const gib = (bytes: number, digits = 1) => `${(bytes / GIB).toFixed(digits)} GiB`;

/** tok/s reads to one decimal below 10 and whole above: 7.4 and 312, never 312.4. */
export const tokS = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

export const tops = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

export const percent = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)} %`;

export const tokens = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}k` : String(n));

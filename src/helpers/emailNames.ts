export const isLikelyEmail = (value: string) => /.+@.+\..+/.test(value.trim());

export const nameFromEmail = (email: string) => email.split("@")[0] || email;

export const environments = {
  dev: { account: '909762691423', cidr: '10.10.0.0/16', multiAz: false },
  test: { account: '223323955607', cidr: '10.20.0.0/16', multiAz: false },
  prod: { account: '474711723859', cidr: '10.30.0.0/16', multiAz: true },
} as const;
export type EnvironmentName = keyof typeof environments;
export function configuration(name: string, account?: string, region = 'us-west-2') {
  if (!(name in environments)) throw new Error('Choose dev, test or prod explicitly.');
  const config = environments[name as EnvironmentName];
  if (account && config.account !== account) throw new Error(`Refusing account ${account}; ${name} requires ${config.account}.`);
  if (region !== 'us-west-2') throw new Error('Cortex regional workloads must use us-west-2.');
  return { ...config, name: name as EnvironmentName, region };
}
export type Configuration = ReturnType<typeof configuration>;

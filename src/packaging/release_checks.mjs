// Release selection is explicit: development HEAD need not equal npm latest.
export function packageIdentity(pkg, lock) {
  if (!pkg?.name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
    throw new Error('Package name and semantic version are required');
  }
  for (const record of [lock, lock?.packages?.['']]) {
    if (record?.name !== pkg.name || record?.version !== pkg.version) {
      throw new Error('package.json and package-lock.json identities differ');
    }
  }
  return { name: pkg.name, version: pkg.version };
}

export function releaseSelection({ tag, npmVersion, tarball, expectedVersion }) {
  if (!tag && !npmVersion && !tarball) throw new Error('Select --tag, --npm-version or --tarball explicitly');
  if (tarball && (tag || npmVersion)) throw new Error('--tarball cannot be combined with tag or npm selection');
  const version = expectedVersion || npmVersion || tag?.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error('An exact semantic version is required (no latest or ranges)');
  }
  if (tag && tag !== `v${version}` && tag !== version) throw new Error('Selected tag and version differ');
  if (npmVersion && npmVersion !== version) throw new Error('Selected npm and expected versions differ');
  return { tag, npmVersion, tarball, version };
}

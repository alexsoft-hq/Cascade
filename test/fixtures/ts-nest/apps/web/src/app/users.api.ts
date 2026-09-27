export async function fetchUsers() {
  const res = await fetch('/api/v1/users');
  return res.json();
}

export async function createUser(email: string) {
  const res = await fetch('/api/v1/users', { method: 'POST', body: JSON.stringify({ email }) });
  return res.json();
}

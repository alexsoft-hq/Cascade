export async function loadSmoke(id: string) {
  return fetch(`/smoke/${id}`);
}

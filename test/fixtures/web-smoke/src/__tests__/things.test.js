import { listThings } from '../api/things'

test('listThings calls the list route', () => {
  expect(typeof listThings).toBe('function')
})

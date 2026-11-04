// Shared HTTP error so modules can fail with a status without importing the store.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

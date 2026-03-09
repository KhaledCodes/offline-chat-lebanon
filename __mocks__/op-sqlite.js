// Mock op-sqlite for Jest
module.exports = {
  open: () => ({
    execute: () => ({ rows: { length: 0, item: () => null } }),
    close: () => {},
  }),
};

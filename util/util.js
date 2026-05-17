module.exports = {
  isObjectEmpty(obj) {
    if (!obj) return true;
    for (const _i in obj) return false;
    return true;
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

// Firebase's free plan allows a set number of reads and writes a day (it resets at midnight Pacific).
// Running out isn't a failure, so the scheduled jobs end quietly and simply run again later,
// instead of failing and sending an email. Any other error still fails as usual.
export const isQuota = (e) => !!e && (e.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String((e && e.message) || e)));
const handler = (e) => {
  if (isQuota(e)) {
    console.log("Firebase's free daily limit has been reached. Nothing is wrong; this will run again after it resets.");
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
};
process.on("uncaughtException", handler);
process.on("unhandledRejection", handler);

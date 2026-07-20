import { benchmarkMode } from "../src/lib/balancing-benchmark";

for (const count of [10, 11, 12, 13, 14, 15]) {
  const balanced = benchmarkMode("BALANCED", count);
  const random = benchmarkMode("RANDOM", count);
  console.log(JSON.stringify({ count, balanced, random }));
}

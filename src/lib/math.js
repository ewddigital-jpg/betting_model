export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function average(values, fallback = 0) {
  if (!values.length) {
    return fallback;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function weightedAverage(entries, fallback = 0) {
  const valid = entries.filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight));

  if (!valid.length) {
    return fallback;
  }

  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);

  if (!totalWeight) {
    return fallback;
  }

  const weightedValue = valid.reduce((sum, entry) => sum + (entry.value * entry.weight), 0);
  return weightedValue / totalWeight;
}

export function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function safeDivide(numerator, denominator, fallback = 0) {
  if (!denominator) {
    return fallback;
  }

  return numerator / denominator;
}

export function impliedProbability(decimalOdds) {
  if (!decimalOdds || decimalOdds <= 1) {
    return 0;
  }

  return 1 / decimalOdds;
}

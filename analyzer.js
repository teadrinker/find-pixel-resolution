
/**
 * Port of TeaMap.FindPixelResolution.AnalyzePeriodicity from C#
 */

function calculateDFTBin(signal, k) {
    let sumRe = 0;
    let sumIm = 0;
    const N = signal.length;
    const angleStep = -2.0 * Math.PI * k / N;

    for (let n = 0; n < N; n++) {
        const angle = angleStep * n;
        const val = signal[n];
        sumRe += val * Math.cos(angle);
        sumIm += val * Math.sin(angle);
    }

    const magnitude = Math.sqrt(sumRe * sumRe + sumIm * sumIm);
    const phase = Math.atan2(sumIm, sumRe);
    return { magnitude, phase };
}

function analyzePeriodicity(data, maxScale) {
    const N = data.length;

    // Calculate total energy
    let totalEnergy = 0;
    for (let i = 0; i < N; i++) totalEnergy += data[i];

    if (totalEnergy < 0.0001) {
        return { scale: 1, offset: 0, confidence: 0 };
    }

    const minK = Math.floor(N / maxScale) < 1 ? 1 : Math.floor(N / maxScale);
    const maxK = Math.floor(N / 2);

    let mageVals = new Array(maxK + 2).fill(0); // Use generic array for double precision
    let globalMax = 0;

    // 1. Coarse sweep
    for (let k = minK; k <= maxK; k++) {
        const res = calculateDFTBin(data, k);
        mageVals[k] = res.magnitude;
        if (res.magnitude > globalMax) globalMax = res.magnitude;
    }

    const threshold = globalMax * 0.4;
    let chosenK = -1;
    let bestMag = -1;

    // 2. Find first significant peak
    for (let k = minK + 1; k < maxK; k++) {
        if (mageVals[k] > mageVals[k - 1] && mageVals[k] > mageVals[k + 1]) {
            if (mageVals[k] > threshold) {
                chosenK = k;

                // Parabolic interpolation
                const y1 = mageVals[k - 1];
                const y2 = mageVals[k];
                const y3 = mageVals[k + 1];
                const d = (y1 - 2 * y2 + y3);
                if (d !== 0) {
                    const peakOffset = (y1 - y3) / (2 * d);
                    chosenK = k + peakOffset;
                }
                bestMag = mageVals[k];
                break;
            }
        }
    }

    if (chosenK === -1) {
        // Fallback to global max
        for (let k = minK; k <= maxK; k++) {
            if (mageVals[k] === globalMax) {
                chosenK = k;
                break;
            }
        }
        bestMag = globalMax;
    }

    // 3. Final precise phase
    const finalRes = calculateDFTBin(data, chosenK);
    const finalPhase = finalRes.phase;
    const finalMag = finalRes.magnitude;

    const scale = N / chosenK;

    // Offset calculation
    // Phase = -2pi * O / S  =>  O = -Phase * S / 2pi
    let offset = (-finalPhase * scale) / (2 * Math.PI);

    // Normalize offset
    while (offset < 0) offset += scale;
    while (offset >= scale) offset -= scale;

    const confidence = finalMag / (totalEnergy / scale);

    return {
        scale: scale,
        offset: offset,
        confidence: confidence
    };
}

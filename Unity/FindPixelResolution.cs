using UnityEngine;
using System.Collections.Generic;
using System.Linq;

namespace TeaMap
{
    public class FindPixelResolution : MonoBehaviour
    {
        [Tooltip("The texture to analyze.")]
        public Texture2D inputTexture;

        [Tooltip("The compute shader for analysis.")]
        public ComputeShader computeShader;

        [Tooltip("Maximum scale factor to test for.")]
        public int maxScaleToCheck = 128; // Increased default

        [System.Serializable]
        public struct ResolutionResult
        {
            public float scaleX;
            public float offsetX;
            public float scaleY;
            public float offsetY;
            public float confidenceX;
            public float confidenceY;
        }

        public ResolutionResult LastResult;

        public ResolutionResult DetectResolution()
        {
            if (inputTexture == null)
            {
                Debug.LogError("Input Texture is null");
                return new ResolutionResult();
            }

            if (computeShader == null)
            {
                computeShader = Resources.Load<ComputeShader>("FindPixelResolution");
                if (computeShader == null)
                {
                    Debug.LogError("Compute Shader not found.");
                    return new ResolutionResult();
                }
            }

            int w = inputTexture.width;
            int h = inputTexture.height;

            // Buffers
            ComputeBuffer colDiffsBuffer = new ComputeBuffer(w, sizeof(float));
            ComputeBuffer rowDiffsBuffer = new ComputeBuffer(h, sizeof(float));

            int kernelCol = computeShader.FindKernel("CalcColDiffs");
            int kernelRow = computeShader.FindKernel("CalcRowDiffs");

            computeShader.SetTexture(kernelCol, "InputTexture", inputTexture);
            computeShader.SetBuffer(kernelCol, "ColDiffs", colDiffsBuffer);
            computeShader.SetInt("Width", w);
            computeShader.SetInt("Height", h);

            computeShader.SetTexture(kernelRow, "InputTexture", inputTexture);
            computeShader.SetBuffer(kernelRow, "RowDiffs", rowDiffsBuffer);
            computeShader.SetInt("Width", w);
            computeShader.SetInt("Height", h);

            // Dispatch
            int threadGroupsX = Mathf.CeilToInt(w / 64.0f);
            computeShader.Dispatch(kernelCol, threadGroupsX, 1, 1);

            int threadGroupsY = Mathf.CeilToInt(h / 64.0f);
            computeShader.Dispatch(kernelRow, threadGroupsY, 1, 1);

            // Read back
            float[] colDiffs = new float[w];
            float[] rowDiffs = new float[h];
            colDiffsBuffer.GetData(colDiffs);
            rowDiffsBuffer.GetData(rowDiffs);

            colDiffsBuffer.Release();
            rowDiffsBuffer.Release();

            // Analyze using Spectral Analysis (DFT) to find periodicity
            var resX = AnalyzePeriodicity(colDiffs, maxScaleToCheck);
            var resY = AnalyzePeriodicity(rowDiffs, maxScaleToCheck);

            LastResult = new ResolutionResult
            {
                scaleX = resX.scale,
                offsetX = resX.offset,
                confidenceX = resX.confidence,
                scaleY = resY.scale,
                offsetY = resY.offset,
                confidenceY = resY.confidence
            };

            Debug.Log($"Detected Resolution: Scale ({LastResult.scaleX:F3}, {LastResult.scaleY:F3}), Offset ({LastResult.offsetX:F3}, {LastResult.offsetY:F3})");
            return LastResult;
        }

        private struct AxisResult
        {
            public float scale;
            public float offset;
            public float confidence;
        }

        // Calculates single DFT component magnitude and phase
        private void CalculateDFTBin(float[] signal, double k, out double magnitude, out double phase)
        {
            double sumRe = 0;
            double sumIm = 0;
            int N = signal.Length;
            double angleStep = -2.0 * System.Math.PI * k / N;

            // Using double precision for accumulation
            for (int n = 0; n < N; n++)
            {
                double angle = angleStep * n;
                // e^(-ix) = cos(x) - i sin(x)
                double val = signal[n];
                sumRe += val * System.Math.Cos(angle);
                sumIm += val * System.Math.Sin(angle);
            }

            magnitude = System.Math.Sqrt(sumRe * sumRe + sumIm * sumIm);
            phase = System.Math.Atan2(sumIm, sumRe);
        }

        private AxisResult AnalyzePeriodicity(float[] data, int maxScale)
        {
            int N = data.Length;
            double totalEnergy = data.Sum();
            if (totalEnergy < 0.0001) return new AxisResult { scale = 1, offset = 0, confidence = 0 };

            // We scan frequencies k corresponding to scales from [2, maxScale]
            // k = N / Scale
            // Min k = N / maxScale
            // Max k = N / 2 (Nyquist, Scale 2)
            
            int minK = Mathf.FloorToInt(N / (float)maxScale);
            if (minK < 1) minK = 1;
            int maxK = N / 2;

            double bestMag = -1;
            double bestK = -1;
            
            // To detect the FUNDAMENTAL frequency (largest scale), we look for the first strong peak.
            // A peak is a local maximum that is significantly higher than neighbors and noise floor.
            
            // First, coarse sweep integer k
            List<double> magnitudes = new List<double>();
            
            // We'll store (k, mag) to find peaks
            double[] mageVals = new double[maxK + 2]; // index is k
            
            // Optimization: Just checking integer k is very effective for N >= 512
            // k represents number of cycles across the image.
            
            double globalMax = 0;

            for (int k = minK; k <= maxK; k++)
            {
                double mag, phase;
                CalculateDFTBin(data, k, out mag, out phase);
                mageVals[k] = mag;
                if (mag > globalMax) globalMax = mag;
            }

            // Find first "significant" local maximum
            // Significant: > 30% of global max? 
            // Also, for a comb filter, the fundamental should be strong.
            // But sometimes there's low frequency noise (gradients across whole image).
            // We might want to skip very low k (scale > maxScale). We did start at minK.
            
            double threshold = globalMax * 0.4; // Heuristic
            double chosenK = -1;

            for (int k = minK + 1; k < maxK; k++)
            {
                if (mageVals[k] > mageVals[k-1] && mageVals[k] > mageVals[k+1])
                {
                    // Local Peak
                    if (mageVals[k] > threshold)
                    {
                        // Found the first strong peak starting from low frequency (large scale)
                        chosenK = k;
                        
                        // Refine k using parabolic interpolation of magnitude
                        // y(x) = ax^2 + bx + c
                        // x = -1, 0, 1 (relative to k)
                        double y1 = mageVals[k-1];
                        double y2 = mageVals[k];
                        double y3 = mageVals[k+1];
                        
                        double d = (y1 - 2 * y2 + y3);
                        if (d != 0)
                        {
                            double peakOffset = (y1 - y3) / (2 * d);
                            chosenK = k + peakOffset;
                        }
                        
                        bestMag = mageVals[k]; // Approximate
                        break;
                    }
                }
            }

            if (chosenK == -1)
            {
                // Fallback to global max if no "early" peak found
                 for (int k = minK; k <= maxK; k++)
                 {
                     if (mageVals[k] == globalMax)
                     {
                         chosenK = k;
                         break;
                     }
                 }
                 bestMag = globalMax;
            }

            // Calculate precise Phase at chosen K
            double finalMag, finalPhase;
            CalculateDFTBin(data, chosenK, out finalMag, out finalPhase);

            float scale = (float)(N / chosenK);
            
            // Offset Calculation
            // The DFT component is Sum x[n] * e^(-i 2pi k n / N)
            // If the signal is a delta train at O, O+S... 
            // x[n] has spikes at n = O + m*S 
            // S = N/k
            // exponent is -i 2pi k (O + m*S)/N = -i 2pi (k*O/N + m) = -i 2pi (O/S + m)
            // = e^(-i 2pi O/S) * 1
            // So Phase = -2pi * O / S
            // O = -Phase * S / (2pi)
            
            // Phase is in [-pi, pi]
            // We want O in [0, S)
            
            float offset = (float)(-finalPhase * scale / (2 * System.Math.PI));
            
            // Normalize offset to [0, scale)
            while (offset < 0) offset += scale;
            while (offset >= scale) offset -= scale;
            
            // Align to "Center" of pixel? 
            // The computed offset is where the "Spikes" (gradients) match the phase 0 reference ( Cos(0)=1 ).
            // Wait. e^(-ix) = cos(x) - i sin(x).
            // Sum x[n] (cos - i sin).
            // If spike at $O$. Phase is -2pi O/S.
            // So if we find O, that is the position of the spike.
            // Spikes occur at pixel boundaries.
            // If pixels are [0,1), [1,2)... Boundary is 1, 2...
            // "Offset" usually refers to the start of the first full pixel.
            // If spike is at 1.5. Then transition is at 1.5.
            // The first pixel started at 1.5 - Scale? Or 1.5 is the start of the second pixel?
            // "Offset" as "Grid Offset". Grid lines are at O, O+S, O+2S.
            // Yes, so O corresponds to the grid line.
            // Visualizer expects "Sample Center" at O + S/2.
            
            // Small correction: The gradient is checking |Pixel[i] - Pixel[i-1]|. compute shader: id.x (current) - (id.x-1) (left).
            // If color change occurs between index 3 and 4.
            // Pixel 3 is color A. Pixel 4 is Color B.
            // Diff at 4 is |A-B| (High). Diff at 3 is |A-A| (Low).
            // So spike is at index 4.
            // This means the grid line is indeed at 4.
            // If the grid starts at 0, lines are at 0, 4, 8...
            // We should see spike at 0? |P[0] - P[-1]|. If clamped, maybe.
            // Usually internal spikes 4, 8, 12 dominate.
            // So detection O=4 is equivalent to O=0 (mod 4).
            // Since we wrap O to [0, scale), O=0.
            // Correct.

            return new AxisResult
            {
                scale = scale,
                offset = offset,
                confidence = (float)(finalMag / (totalEnergy / scale)) // Rough confidence
            };
        }
    }
}

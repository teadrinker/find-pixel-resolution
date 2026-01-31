using UnityEngine;
using System.IO;
using System.Linq;

namespace TeaMap
{
    [RequireComponent(typeof(WindowsFileDrop))]
    [RequireComponent(typeof(FindPixelResolution))]
    public class FindPixelResolutionCli : MonoBehaviour
    {
        private WindowsFileDrop _fileDrop;
        private FindPixelResolution _finder;

        // Visualizer
        private Texture2D _originalTexture;
        private Texture2D _reconstructedTexture;
        private bool _showOriginal = true;
        private float _toggleTimer = 0f;
        private const float ToggleInterval = 1.0f;
        
        private string _infoText = "Drop an image to test";

        private void OnEnable()
        {
            _fileDrop = GetComponent<WindowsFileDrop>();
            _finder = GetComponent<FindPixelResolution>();
            _fileDrop.OnFilesDropped += OnFilesDropped;
        }

        private void Start()
        {
            ProcessCommandLineArgs();
        }

        private void OnDisable()
        {
            if (_fileDrop != null)
                _fileDrop.OnFilesDropped -= OnFilesDropped;
        }

        private void ProcessCommandLineArgs()
        {
            string[] args = System.Environment.GetCommandLineArgs();
            // args[0] is usually the program name/path
            if (args != null && args.Length > 1)
            {
                foreach (var arg in args.Skip(1))
                {
                    if (IsImageFile(arg))
                    {
                        Debug.Log($"Processing command line argument: {arg}");
                        LoadAndTest(arg);
                        // Process first valid image found
                        break;
                    }
                }
            }
        }

        private bool IsImageFile(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            if (!File.Exists(path)) return false;
            string ext = Path.GetExtension(path).ToLower();
            return ext == ".png" || ext == ".jpg" || ext == ".jpeg";
        }

        private void Update()
        {
            if (Input.GetKeyDown(KeyCode.Escape))
            {
                Application.Quit();
            }

            if (_originalTexture != null && _reconstructedTexture != null)
            {
                _toggleTimer += Time.deltaTime;
                if (_toggleTimer >= ToggleInterval)
                {
                    _toggleTimer = 0f;
                    _showOriginal = !_showOriginal;
                }
            }
        }

        private void OnGUI()
        {
            Texture texToShow = (_originalTexture != null && _reconstructedTexture != null && !_showOriginal) 
                ? _reconstructedTexture 
                : _originalTexture != null ? _originalTexture : null;

            if (texToShow != null)
            {
                // Calculate aspect ratio preserving rect
                float screenAspect = (float)Screen.width / Screen.height;
                float texAspect = (float)texToShow.width / texToShow.height;

                Rect r;
                if (texAspect > screenAspect)
                {
                    float h = Screen.width / texAspect;
                    r = new Rect(0, (Screen.height - h) * 0.5f, Screen.width, h);
                }
                else
                {
                    float w = Screen.height * texAspect;
                    r = new Rect((Screen.width - w) * 0.5f, 0, w, Screen.height);
                }

                GUI.DrawTexture(r, texToShow, ScaleMode.StretchToFill, false);
                
                // Info Box
                string mode = _showOriginal ? "ORIGINAL INPUT" : "RECONSTRUCTED (Upscaled)";
                GUI.color = Color.black;
                GUI.DrawTexture(new Rect(10, 10, 450, 100), Texture2D.whiteTexture);
                GUI.color = Color.white;
                GUI.Label(new Rect(20, 20, 430, 90), $"Showing: {mode}\n{_infoText}");
            }
            else
            {
                GUI.Label(new Rect(20, 20, 300, 50), "Drag and drop an image here (or onto the EXE) to test resolution detection.");
            }
        }

        private void OnFilesDropped(string[] files)
        {
            foreach (string path in files)
            {
                if (IsImageFile(path))
                {
                    LoadAndTest(path);
                    break;
                }
            }
        }

        private void LoadAndTest(string path)
        {
            Debug.Log($"Loading texture from: {path}");
            byte[] data = File.ReadAllBytes(path);
            Texture2D tex = new Texture2D(2, 2);
            if (tex.LoadImage(data))
            {
                tex.name = Path.GetFileName(path);
                tex.filterMode = FilterMode.Point;
                _originalTexture = tex;
                _finder.inputTexture = tex;

                #if UNITY_EDITOR
                if (_finder.computeShader == null)
                {
                    string[] guids = UnityEditor.AssetDatabase.FindAssets("FindPixelResolution t:ComputeShader");
                    if (guids.Length > 0)
                    {
                        string csPath = UnityEditor.AssetDatabase.GUIDToAssetPath(guids[0]);
                        _finder.computeShader = UnityEditor.AssetDatabase.LoadAssetAtPath<ComputeShader>(csPath);
                    }
                }
                #endif

                var result = _finder.DetectResolution();
                
                _infoText = $"File: {tex.name}\n" +
                            $"Detected: Scale {result.scaleX:F3}x{result.scaleY:F3}, Offset ({result.offsetX:F3}, {result.offsetY:F3})\n" +
                            $"Confidence: {result.confidenceX:F2}, {result.confidenceY:F2}";
                
                Debug.Log($"<color=green>{_infoText}</color>");

                ReconstructImage(path, tex, result);
            }
            else
            {
                Debug.LogError($"Failed to load texture from {path}");
            }
        }

        private void ReconstructImage(string originalPath, Texture2D original, FindPixelResolution.ResolutionResult res)
        {
            int w = original.width;
            int h = original.height;
            float sx = res.scaleX;
            float sy = res.scaleY;
            float ox = res.offsetX;
            float oy = res.offsetY;

            // Safety clamp
            if (sx < 1.0f) sx = 1.0f;
            if (sy < 1.0f) sy = 1.0f;

            _reconstructedTexture = new Texture2D(w, h, TextureFormat.RGBA32, false);
            _reconstructedTexture.filterMode = FilterMode.Point;

            Color[] srcPixels = original.GetPixels();
            Color[] dstPixels = new Color[w * h];

            // Cache for grid cell colors
            var cellColors = new System.Collections.Generic.Dictionary<Vector2Int, Color>();

            int minGridX = int.MaxValue;
            int maxGridX = int.MinValue;
            int minGridY = int.MaxValue;
            int maxGridY = int.MinValue;

            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    // Find grid cell index
                    int gridX = Mathf.FloorToInt((x - ox) / sx);
                    int gridY = Mathf.FloorToInt((y - oy) / sy);

                    // Track bounds
                    if (gridX < minGridX) minGridX = gridX;
                    if (gridX > maxGridX) maxGridX = gridX;
                    if (gridY < minGridY) minGridY = gridY;
                    if (gridY > maxGridY) maxGridY = gridY;

                    Vector2Int key = new Vector2Int(gridX, gridY);

                    if (!cellColors.TryGetValue(key, out Color avgColor))
                    {
                        // Calculate sample box center
                        float centerX = ox + gridX * sx + sx * 0.5f;
                        float centerY = oy + gridY * sy + sy * 0.5f;

                        // Radius 0.3 of scale
                        float rx = sx * 0.3f;
                        float ry = sy * 0.3f;

                        // Determine integer bounds 
                        int xMin = Mathf.CeilToInt(centerX - rx);
                        int xMax = Mathf.FloorToInt(centerX + rx);
                        int yMin = Mathf.CeilToInt(centerY - ry);
                        int yMax = Mathf.FloorToInt(centerY + ry);

                        float rSum = 0, gSum = 0, bSum = 0, aSum = 0;
                        int count = 0;

                        for (int sy_loop = yMin; sy_loop <= yMax; sy_loop++)
                        {
                            if (sy_loop < 0 || sy_loop >= h) continue;
                            int rowOffset = sy_loop * w;
                            for (int sx_loop = xMin; sx_loop <= xMax; sx_loop++)
                            {
                                if (sx_loop < 0 || sx_loop >= w) continue;
                                Color c = srcPixels[rowOffset + sx_loop];
                                rSum += c.r; gSum += c.g; bSum += c.b; aSum += c.a;
                                count++;
                            }
                        }

                        if (count > 0)
                        {
                            avgColor = new Color(rSum / count, gSum / count, bSum / count, aSum / count);
                        }
                        else
                        {
                            // Fallback to center point
                            int px = Mathf.Clamp(Mathf.RoundToInt(centerX), 0, w - 1);
                            int py = Mathf.Clamp(Mathf.RoundToInt(centerY), 0, h - 1);
                            avgColor = srcPixels[py * w + px];
                        }

                        cellColors[key] = avgColor;
                    }

                    dstPixels[y * w + x] = avgColor;
                }
            }

            _reconstructedTexture.SetPixels(dstPixels);
            _reconstructedTexture.Apply();

            _showOriginal = false;
            _toggleTimer = 0f;

            // Generate and Save LowRes Image
            int lrW = maxGridX - minGridX + 1;
            int lrH = maxGridY - minGridY + 1;

            if (lrW > 0 && lrH > 0)
            {
                Texture2D lowResTex = new Texture2D(lrW, lrH, TextureFormat.RGBA32, false);
                Color[] lrPixels = new Color[lrW * lrH];

                for (int gy = 0; gy < lrH; gy++)
                {
                    for (int gx = 0; gx < lrW; gx++)
                    {
                        int actualGridX = minGridX + gx;
                        int actualGridY = minGridY + gy;
                        
                        if (cellColors.TryGetValue(new Vector2Int(actualGridX, actualGridY), out Color c))
                        {
                            lrPixels[gy * lrW + gx] = c;
                        }
                        else
                        {
                            // Should ideally not happen if loop above covered all, but for safety: 
                            lrPixels[gy * lrW + gx] = Color.black; 
                        }
                    }
                }

                lowResTex.SetPixels(lrPixels);
                lowResTex.Apply();

                string dir = Path.GetDirectoryName(originalPath);
                string name = Path.GetFileNameWithoutExtension(originalPath);
                // Create suffix based on how it was invoked? No, consistent suffix.
                string newPath = Path.Combine(dir, name + "_lowres.png");
                
                File.WriteAllBytes(newPath, lowResTex.EncodeToPNG());
                Debug.Log($"Saved LowRes Image to: {newPath}\nResolution: {lrW}x{lrH}");
            }
        }
    }
}

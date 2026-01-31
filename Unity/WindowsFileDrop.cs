// needs https://github.com/JJJohan/UnityDragDrop/blob/master/Assets/DragDropController.cs
using System.Collections.Generic;
using UnityEngine;

namespace TeaMap
{
    public class WindowsFileDrop : MonoBehaviour
    {
        public System.Action<string[]> OnFilesDropped;

        private DragDropController _controller; // needs https://github.com/JJJohan/UnityDragDrop/blob/master/Assets/DragDropController.cs
        private List<string> _droppedFiles = new List<string>();
        private bool _hasDropped = false;

        private void OnEnable()
        {
            _controller = GetComponent<DragDropController>();
            if (_controller == null)
            {
                _controller = gameObject.AddComponent<DragDropController>();
            }

            _controller.OnDropped += OnDrop;
            _controller.Register();
        }

        private void OnDisable()
        {
            if (_controller != null)
            {
                _controller.OnDropped -= OnDrop;
                _controller.Unregister();
                // We don't destroy the controller blindly as it might be used by others, 
                // but since we added it potentially, let's leave it be or destroy it if we are sure?
                // TeaMapApp adds/destroys WindowsFileDrop dynamically. 
                // It's cleaner to let the component stay if it wasn't destroyed, but TeaMapApp destroys WindowsFileDrop explicitly.
                // We should probably destroy the controller if we created it, but distinguishing that is hard.
                // However, since TeaMapApp destroys THIS component, the DragDropController remains on the GameObject (TeaMapApp).
                // If TeaMapApp is destroyed, all components go. If just disabled/enabled, we might pile up controllers if we kept Adding.
                // But GetComponent checks first, so we are safe.
            }
        }

        private void Update()
        {
            if (_hasDropped && _droppedFiles.Count > 0)
            {
                // Dispatch aggregated files
                OnFilesDropped?.Invoke(_droppedFiles.ToArray());
                _droppedFiles.Clear();
                _hasDropped = false;
            }
        }

        private void OnDrop(string filePath, int x, int y)
        {
            _droppedFiles.Add(filePath);
            _hasDropped = true;
        }
    }
}

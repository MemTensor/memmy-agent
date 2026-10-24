#pragma once
#include <algorithm>
#include <cmath>

namespace memmy_pip {
struct Rect { double x, y, width, height; };
inline Rect aspectFit(double width, double height, double sourceWidth, double sourceHeight) {
  if (sourceWidth <= 0 || sourceHeight <= 0) return {0, 0, width, height};
  const double scale = std::min(width / sourceWidth, height / sourceHeight);
  const double fittedWidth = sourceWidth * scale, fittedHeight = sourceHeight * scale;
  return {(width - fittedWidth) / 2, (height - fittedHeight) / 2, fittedWidth, fittedHeight};
}
// Coordinates use AppKit's bottom-left origin; the action contract uses top-left.
inline bool normalizedPoint(Rect image, double localX, double localY, double &x, double &y) {
  if (image.width <= 0 || image.height <= 0 || !std::isfinite(localX) || !std::isfinite(localY)
      || localX < image.x || localY < image.y
      || localX >= image.x + image.width || localY >= image.y + image.height) return false;
  x = (localX - image.x) / image.width;
  y = 1 - (localY - image.y) / image.height;
  return true;
}
}

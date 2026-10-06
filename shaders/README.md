# shaders/

WGSL 着色器源码目录。M0 阶段画布链路走 Canvas2D，此处暂为空；
M1 接入 WebGPU 渲染管线（回退 WebGL2）后，图层合成、色彩管理、
滤镜核等会以 `.wgsl` 文件落在本目录。

命名约定（拟定）：`<用途>.<阶段>.wgsl`，例如 `composite.blend.wgsl`、
`color.convert.wgsl`。

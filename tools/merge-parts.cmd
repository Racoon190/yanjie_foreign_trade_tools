@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "OUT=YanJie-1.6.0-portable.zip"

if not exist "%OUT%.part01" (
    echo [错误] 当前目录没有找到 %OUT%.part01
    echo.
    echo 请先在 Release 页面下载全部分卷，保持文件名不变，并和本脚本放在同一个文件夹。
    echo.
    pause
    exit /b 1
)

if exist "%OUT%" del /q "%OUT%"

echo 正在合并分卷 ...
copy /b /y "%OUT%.part??" "%OUT%" >nul
if errorlevel 1 (
    echo [错误] 合并失败，请检查分卷是否齐全。
    pause
    exit /b 1
)

echo 已生成：%OUT%
echo.
echo 正在校验 SHA256 ...
certutil -hashfile "%OUT%" SHA256
echo.
echo 期望值：
echo cd157331218de74fe5dafa28d61d4304626cd75d949dd03c59d815ec1a6faa67
echo.
echo 两个值一致即可解压运行；不一致请删除全部分卷重新下载。
pause

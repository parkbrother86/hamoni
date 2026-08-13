"""Windows 에서 pip 설치된 NVIDIA 런타임 DLL 을 찾게 해주는 공용 헬퍼.

ctranslate2 / llama_cpp 둘 다 plain LoadLibrary 로 DLL 을 열기 때문에
add_dll_directory 만으로는 부족하고 PATH 선두 추가가 필요하다.
Linux 휠은 rpath 로 자동 해결되므로 no-op.

    import cuda_path  # 반드시 ctranslate2 / llama_cpp import 보다 먼저
"""

import glob
import os
import sys

if os.name == "nt":
    _dirs = []
    for _site in sys.path:
        _dirs += glob.glob(os.path.join(_site, "nvidia", "*", "bin"))
    for _d in _dirs:
        try:
            os.add_dll_directory(_d)
        except OSError:
            pass
    if _dirs:
        os.environ["PATH"] = os.pathsep.join(_dirs) + os.pathsep + os.environ.get("PATH", "")

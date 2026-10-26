// Copyright (C) 2026 Arc Power contributors
// SPDX-License-Identifier: GPL-2.0-only
// Starts an explicitly selected game at the Explorer user's normal integrity.
// This executable never launches a game from its elevated relay mode.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <exdisp.h>
#include <shldisp.h>
#include <servprov.h>
#include <shlguid.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <map>
#include <cstdio>
#include <cstdint>
#include <cwctype>

using Microsoft::WRL::ComPtr;
struct Handle {
 HANDLE value=nullptr;
 explicit Handle(HANDLE v=nullptr):value(v){}
 ~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
 Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;
 operator HANDLE() const{return value;}
};
struct Identity {std::wstring sid;DWORD session=0,integrity=0;bool elevated=false;};
static bool identity(HANDLE process,Identity& out){
 HANDLE raw=nullptr;if(!OpenProcessToken(process,TOKEN_QUERY,&raw))return false;Handle token(raw);
 DWORD bytes=0;GetTokenInformation(token,TokenUser,nullptr,0,&bytes);std::vector<BYTE> user(bytes);
 if(!bytes||!GetTokenInformation(token,TokenUser,user.data(),bytes,&bytes))return false;
 LPWSTR sid=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,&sid))return false;
 out.sid=sid;LocalFree(sid);
 bytes=sizeof(out.session);if(!GetTokenInformation(token,TokenSessionId,&out.session,bytes,&bytes))return false;
 TOKEN_ELEVATION elevation{};bytes=sizeof(elevation);if(!GetTokenInformation(token,TokenElevation,&elevation,bytes,&bytes))return false;out.elevated=elevation.TokenIsElevated!=0;
 bytes=0;GetTokenInformation(token,TokenIntegrityLevel,nullptr,0,&bytes);std::vector<BYTE> level(bytes);
 if(!bytes||!GetTokenInformation(token,TokenIntegrityLevel,level.data(),bytes,&bytes))return false;
 PSID label=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(level.data())->Label.Sid;
 out.integrity=*GetSidSubAuthority(label,*GetSidSubAuthorityCount(label)-1);return true;
}
static bool shell_identity(Identity& out){DWORD pid=0;HWND shell=GetShellWindow();if(!shell||!GetWindowThreadProcessId(shell,&pid))return false;Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));return process.value&&identity(process,out);}
static std::wstring module_path(){std::vector<wchar_t> p(32768);DWORD n=GetModuleFileNameW(nullptr,p.data(),static_cast<DWORD>(p.size()));return n&&n<p.size()?std::wstring(p.data(),n):L"";}
static std::wstring parent(const std::wstring& p){const auto i=p.find_last_of(L"\\/");return i==std::wstring::npos?L"":p.substr(0,i);}
static std::wstring quote(const std::wstring& p){std::wstring out=L"\"";size_t slashes=0;for(wchar_t c:p){if(c==L'\\'){++slashes;continue;}if(c==L'\"')out.append(slashes*2+1,L'\\');else out.append(slashes,L'\\');slashes=0;out.push_back(c);}out.append(slashes*2,L'\\');out.push_back(L'\"');return out;}
static bool relay(const std::wstring& request){
 Identity self,shell;if(!identity(GetCurrentProcess(),self)||!shell_identity(shell)||self.sid!=shell.sid||self.session!=shell.session||shell.elevated||shell.integrity!=SECURITY_MANDATORY_MEDIUM_RID)return false;
 const auto module=module_path();if(module.empty())return false;
 const HRESULT init=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);if(FAILED(init))return false;
 ComPtr<IShellWindows> windows;ComPtr<IDispatch> desktop,background,application;ComPtr<IServiceProvider> services;ComPtr<IShellBrowser> browser;ComPtr<IShellView> view;ComPtr<IShellFolderViewDual> folder;ComPtr<IShellDispatch2> dispatch;
 VARIANT empty;VariantInit(&empty);LONG hwnd=0;
 HRESULT hr=CoCreateInstance(CLSID_ShellWindows,nullptr,CLSCTX_LOCAL_SERVER,IID_PPV_ARGS(&windows));
 if(SUCCEEDED(hr))hr=windows->FindWindowSW(&empty,&empty,SWC_DESKTOP,&hwnd,SWFO_NEEDDISPATCH,&desktop);
 if(SUCCEEDED(hr))hr=desktop.As(&services);
 if(SUCCEEDED(hr))hr=services->QueryService(SID_STopLevelBrowser,IID_PPV_ARGS(&browser));
 if(SUCCEEDED(hr))hr=browser->QueryActiveShellView(&view);
 if(SUCCEEDED(hr))hr=view->GetItemObject(SVGIO_BACKGROUND,IID_PPV_ARGS(&background));
 if(SUCCEEDED(hr))hr=background.As(&folder);
 if(SUCCEEDED(hr))hr=folder->get_Application(&application);
 if(SUCCEEDED(hr))hr=application.As(&dispatch);
 VARIANT args,cwd,verb,show;VariantInit(&args);VariantInit(&cwd);VariantInit(&verb);VariantInit(&show);
 V_VT(&args)=VT_BSTR;V_BSTR(&args)=SysAllocString((L"--worker "+quote(request)).c_str());V_VT(&cwd)=VT_BSTR;V_BSTR(&cwd)=SysAllocString(parent(module).c_str());V_VT(&verb)=VT_BSTR;V_BSTR(&verb)=SysAllocString(L"open");V_VT(&show)=VT_I4;V_I4(&show)=SW_HIDE;
 BSTR file=SysAllocString(module.c_str());
 if(SUCCEEDED(hr)&&file&&V_BSTR(&args)&&V_BSTR(&cwd)&&V_BSTR(&verb))hr=dispatch->ShellExecute(file,args,cwd,verb,show);else if(SUCCEEDED(hr))hr=E_OUTOFMEMORY;
 SysFreeString(file);VariantClear(&args);VariantClear(&cwd);VariantClear(&verb);VariantClear(&show);VariantClear(&empty);
 dispatch.Reset();application.Reset();folder.Reset();background.Reset();view.Reset();browser.Reset();services.Reset();desktop.Reset();windows.Reset();CoUninitialize();return SUCCEEDED(hr);
}
static bool read_request(const std::wstring& file,std::vector<std::wstring>& fields){
 Handle h(CreateFileW(file.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));if(h.value==INVALID_HANDLE_VALUE)return false;
 BY_HANDLE_FILE_INFORMATION info{};LARGE_INTEGER size{};
 if(!GetFileInformationByHandle(h,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||!GetFileSizeEx(h,&size)||size.QuadPart<8||size.QuadPart>131072)return false;
 std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart));DWORD got=0;if(!ReadFile(h,bytes.data(),static_cast<DWORD>(bytes.size()),&got,nullptr)||got!=bytes.size())return false;
 size_t pos=0;auto number=[&](uint32_t& n){if(pos+4>bytes.size())return false;memcpy(&n,bytes.data()+pos,4);pos+=4;return true;};uint32_t magic=0,count=0;
 if(!number(magic)||!number(count)||magic!=0x314c5341||count!=6)return false;
 for(uint32_t i=0;i<count;++i){uint32_t chars=0;if(!number(chars)||chars>32767||pos+static_cast<size_t>(chars)*2>bytes.size())return false;std::wstring text(chars,L'\0');memcpy(text.data(),bytes.data()+pos,static_cast<size_t>(chars)*2);pos+=static_cast<size_t>(chars)*2;if(text.find_first_of(std::wstring(L"\0\r\n",3))!=std::wstring::npos)return false;fields.push_back(text);}
 return pos==bytes.size();
}
static bool hash_file(const std::wstring& file,const std::wstring& expected){
 Handle h(CreateFileW(file.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));if(h.value==INVALID_HANDLE_VALUE)return false;
 BY_HANDLE_FILE_INFORMATION info{};if(!GetFileInformationByHandle(h,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||info.nNumberOfLinks!=1)return false;
 BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;bool ok=BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0;
 if(ok)ok=BCryptCreateHash(alg,&hash,nullptr,0,nullptr,0,0)>=0;
 BYTE bytes[65536];DWORD read=0;while(ok){if(!ReadFile(h,bytes,sizeof(bytes),&read,nullptr)){ok=false;break;}if(!read)break;ok=BCryptHashData(hash,bytes,read,0)>=0;}
 BYTE digest[32]{};if(ok)ok=BCryptFinishHash(hash,digest,sizeof(digest),0)>=0;if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);
 const wchar_t* hex=L"0123456789ABCDEF";std::wstring actual;for(BYTE byte:digest){actual+=hex[byte>>4];actual+=hex[byte&15];}return ok&&actual==expected;
}
static std::wstring json(const std::wstring& text){std::wstring out=L"\"";for(wchar_t c:text){if(c==L'\\'||c==L'\"'){out+=L'\\';out+=c;}else if(c<32){wchar_t escaped[8]{};swprintf_s(escaped,L"\\u%04x",static_cast<unsigned>(c));out+=escaped;}else out+=c;}return out+L"\"";}
static bool report(const std::wstring& request,const std::wstring& text){
 Handle h(CreateFileW((request+L".result.json").c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));if(h.value==INVALID_HANDLE_VALUE)return false;
 int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);if(count<=0)return false;std::string data(static_cast<size_t>(count),'\0');if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),data.data(),count,nullptr,nullptr))return false;DWORD written=0;return WriteFile(h,data.data(),static_cast<DWORD>(data.size()),&written,nullptr)&&written==data.size();
}
static bool existing_game(const std::wstring& exe){Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));if(snapshot.value==INVALID_HANDLE_VALUE)return true;PROCESSENTRY32W row{sizeof(row)};for(BOOL next=Process32FirstW(snapshot,&row);next;next=Process32NextW(snapshot,&row)){if(_wcsicmp(row.szExeFile,exe.substr(exe.find_last_of(L"\\/")+1).c_str()))continue;Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,row.th32ProcessID));wchar_t path[32768];DWORD size=32768;if(process.value&&QueryFullProcessImageNameW(process,0,path,&size)&&!_wcsicmp(path,exe.c_str()))return true;}return false;}
static std::vector<wchar_t> environment(const std::wstring& base,const std::wstring& steamId){
 struct Less{bool operator()(const std::wstring&a,const std::wstring&b)const{return _wcsicmp(a.c_str(),b.c_str())<0;}};std::map<std::wstring,std::wstring,Less> vars;
 LPWCH block=GetEnvironmentStringsW();if(block){for(const wchar_t*p=block;*p;p+=wcslen(p)+1){std::wstring row=p;const auto equals=row.find(L'=',row[0]==L'='?1:0);if(equals!=std::wstring::npos)vars[row.substr(0,equals)]=row.substr(equals+1);}FreeEnvironmentStringsW(block);}
 vars[L"RESHADE_BASE_PATH_OVERRIDE"]=base;vars[L"RESHADE_DISABLE_LOADING_CHECK"]=L"1";
 if(!steamId.empty()){vars[L"SteamAppId"]=steamId;vars[L"SteamGameId"]=steamId;}
 std::vector<wchar_t> result;for(const auto&v:vars){const auto row=v.first+L"="+v.second;result.insert(result.end(),row.begin(),row.end());result.push_back(0);}result.push_back(0);return result;
}
static int worker(const std::wstring& request){
 Identity self,shell;std::vector<std::wstring> fields;
 if(!identity(GetCurrentProcess(),self)||!shell_identity(shell)||self.elevated||self.integrity!=SECURITY_MANDATORY_MEDIUM_RID||self.sid!=shell.sid||self.session!=shell.session){report(request,L"{\"ok\":false,\"error\":\"normal_user_identity\"}");return 2;}
 if(!read_request(request,fields)){report(request,L"{\"ok\":false,\"error\":\"invalid_request\"}");return 3;}
 const auto& exe=fields[0];const auto& cwd=fields[1];auto command=fields[2];const auto& dll=fields[3];const auto& steam=fields[4];const auto& dllHash=fields[5];
 DWORD type=0;if(!GetBinaryTypeW(exe.c_str(),&type)||type!=SCS_64BIT_BINARY||existing_game(exe)||dllHash.size()!=64||!hash_file(dll,dllHash)||(!steam.empty()&&steam.find_first_not_of(L"0123456789")!=std::wstring::npos)){report(request,L"{\"ok\":false,\"error\":\"launch_preflight\"}");return 4;}
 auto env=environment(parent(dll),steam);STARTUPINFOW startup{sizeof(startup)};PROCESS_INFORMATION pi{};
 if(!CreateProcessW(exe.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,env.data(),cwd.c_str(),&startup,&pi)){report(request,L"{\"ok\":false,\"error\":\"create_process\",\"win32\":"+std::to_wstring(GetLastError())+L"}");return 5;}
 Handle process(pi.hProcess),thread(pi.hThread);FILETIME created{},exited{},kernel{},user{};Identity child;DWORD failure=0;bool injected=false,timedOut=false;
 if(!GetProcessTimes(process,&created,&exited,&kernel,&user)||!identity(process,child)||child.elevated||child.integrity!=SECURITY_MANDATORY_MEDIUM_RID||child.sid!=self.sid||child.session!=self.session)failure=ERROR_ACCESS_DENIED;
 void* remote=nullptr;
 if(!failure){const size_t bytes=(dll.size()+1)*sizeof(wchar_t);remote=VirtualAllocEx(process,nullptr,bytes,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!remote||!WriteProcessMemory(process,remote,dll.c_str(),bytes,nullptr))failure=GetLastError();}
 if(!failure){const auto loader=reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"LoadLibraryW"));Handle loadThread(loader?CreateRemoteThread(process,nullptr,0,loader,remote,0,nullptr):nullptr);if(!loadThread.value)failure=GetLastError();else{const DWORD wait=WaitForSingleObject(loadThread,10000);if(wait==WAIT_OBJECT_0){DWORD result=0;if(!GetExitCodeThread(loadThread,&result)||!result)failure=ERROR_DLL_INIT_FAILED;else injected=true;}else{timedOut=true;failure=ERROR_TIMEOUT;}}}
 if(remote&&!timedOut)VirtualFreeEx(process,remote,0,MEM_RELEASE);
 const DWORD resume=ResumeThread(thread);const bool resumed=resume==1;if(!resumed&&!failure)failure=GetLastError();
 const uint64_t creation=(static_cast<uint64_t>(created.dwHighDateTime)<<32)|created.dwLowDateTime;
 const auto body=L"{\"ok\":"+std::wstring(injected&&resumed?L"true":L"false")+L",\"pid\":"+std::to_wstring(pi.dwProcessId)+L",\"creationFiletime\":"+json(std::to_wstring(creation))+L",\"exePath\":"+json(exe)+L",\"injected\":"+(injected?L"true":L"false")+L",\"resumed\":"+(resumed?L"true":L"false")+L",\"remoteLoaderTimedOut\":"+(timedOut?L"true":L"false")+L",\"win32\":"+std::to_wstring(failure)+L",\"integrity\":"+std::to_wstring(child.integrity)+L",\"session\":"+std::to_wstring(child.session)+L",\"sid\":"+json(child.sid)+L"}";
 return report(request,body)?0:6;
}
int wmain(int argc,wchar_t**argv){
 if(argc==2&&!wcscmp(argv[1],L"--help")){std::puts("--launch <request.bin>: relay to normal Explorer user; --worker <request.bin>: normal-user suspended launch and managed runtime load");return 0;}
 if(argc!=3)return 1;
 if(!wcscmp(argv[1],L"--worker"))return worker(argv[2]);
 if(!wcscmp(argv[1],L"--launch")){Identity self;if(!identity(GetCurrentProcess(),self))return 2;if(!self.elevated)return worker(argv[2]);return relay(argv[2])?0:7;}
 return 1;
}

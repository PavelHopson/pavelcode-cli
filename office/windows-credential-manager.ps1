param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('write', 'read', 'delete', 'status')]
  [string]$Operation,

  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 256)]
  [string]$Target,

  [Parameter(Mandatory = $false)]
  [ValidateLength(1, 256)]
  [string]$UserName = 'eclipse-hopson-sentinel'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public static class SentinelCredentialManager
{
    private const int CredTypeGeneric = 1;
    private const int CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    public static void Write(string target, string userName, byte[] secret)
    {
        IntPtr blob = IntPtr.Zero;
        try
        {
            blob = Marshal.AllocCoTaskMem(secret.Length);
            Marshal.Copy(secret, 0, blob, secret.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = target,
                CredentialBlobSize = (uint)secret.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = userName
            };
            if (!CredWrite(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            if (blob != IntPtr.Zero)
            {
                for (var offset = 0; offset < secret.Length; offset++) Marshal.WriteByte(blob, offset, 0);
                Marshal.FreeCoTaskMem(blob);
            }
        }
    }

    public static bool WriteIfAbsent(string target, string userName, byte[] secret)
    {
        var targetBytes = Encoding.UTF8.GetBytes(target);
        byte[] digest = null;
        string mutexName;
        try
        {
            using (var sha = SHA256.Create())
            {
                digest = sha.ComputeHash(targetBytes);
            }
            mutexName = "Local\\EclipseForge.Sentinel.Office." + BitConverter.ToString(digest).Replace("-", "");
        }
        finally
        {
            Array.Clear(targetBytes, 0, targetBytes.Length);
        }

        using (var mutex = new Mutex(false, mutexName))
        {
            var acquired = false;
            try
            {
                try { acquired = mutex.WaitOne(10000); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new TimeoutException("Credential write lock timed out");
                var existing = Read(target);
                if (existing != null)
                {
                    try { return false; }
                    finally { Array.Clear(existing, 0, existing.Length); }
                }
                Write(target, userName, secret);
                return true;
            }
            finally
            {
                if (acquired) mutex.ReleaseMutex();
                if (digest != null) Array.Clear(digest, 0, digest.Length);
            }
        }
    }

    public static byte[] Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, CredTypeGeneric, 0, out pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound) return null;
            throw new Win32Exception(error);
        }
        try
        {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            var result = new byte[credential.CredentialBlobSize];
            if (result.Length > 0) Marshal.Copy(credential.CredentialBlob, result, 0, result.Length);
            return result;
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static bool Delete(string target)
    {
        if (CredDelete(target, CredTypeGeneric, 0)) return true;
        var error = Marshal.GetLastWin32Error();
        if (error == ErrorNotFound) return false;
        throw new Win32Exception(error);
    }
}
'@

switch ($Operation) {
  'write' {
    $encoded = [Console]::In.ReadToEnd().Trim()
    $secret = $null
    try {
      $secret = [Convert]::FromBase64String($encoded)
      if ($secret.Length -lt 32 -or $secret.Length -gt 128) { throw 'INVALID_SECRET_LENGTH' }
      if ([SentinelCredentialManager]::WriteIfAbsent($Target, $UserName, $secret)) {
        [Console]::Out.Write('STORED')
      }
      else { [Console]::Out.Write('EXISTS') }
    }
    finally {
      if ($null -ne $secret) { [Array]::Clear($secret, 0, $secret.Length) }
      $encoded = $null
    }
  }
  'read' {
    $secret = $null
    try {
      $secret = [SentinelCredentialManager]::Read($Target)
      if ($null -eq $secret) { [Console]::Out.Write('MISSING'); break }
      [Console]::Out.Write('SECRET:')
      [Console]::Out.Write([Convert]::ToBase64String($secret))
    }
    finally {
      if ($null -ne $secret) { [Array]::Clear($secret, 0, $secret.Length) }
    }
  }
  'delete' {
    if ([SentinelCredentialManager]::Delete($Target)) { [Console]::Out.Write('DELETED') }
    else { [Console]::Out.Write('MISSING') }
  }
  'status' {
    $secret = $null
    try {
      $secret = [SentinelCredentialManager]::Read($Target)
      if ($null -eq $secret) { [Console]::Out.Write('MISSING') }
      else { [Console]::Out.Write('PRESENT') }
    }
    finally {
      if ($null -ne $secret) { [Array]::Clear($secret, 0, $secret.Length) }
    }
  }
}

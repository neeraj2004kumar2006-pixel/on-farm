NEXT STEPS

1. Extract this ZIP into your existing:
   D:\Downloads\form automation

2. IMPORTANT: replace the old package.json with the package.json from this ZIP.
   Keep your existing node_modules if you want; run npm install again.

3. Put your real data into farmers.xlsx.
   Delete/replace the EXAMPLE row.

4. In PowerShell:
   npm install

5. Start:
   node automation.js

6. A Chromium window will open. You login manually and open the actual form.

7. Open in your normal Chrome:
   http://localhost:3789

8. Press START.
   The script processes Excel rows one by one.

9. Press STOP if you see something wrong.
   It will stop before starting the next action as soon as possible.

10. In farmers.xlsx:
   DONE = submitted successfully
   ERROR = stopped on that row; see Error column

The script does not click '+ Add Crop or Survey Number' for the next farmer.
That button appears to add another crop/survey row for the SAME farmer.

    const alertBox = document.getElementById("alertBox");
    const form = document.getElementById("loginForm");
    const submitBtn = document.getElementById("submitBtn");
    const btnText = document.getElementById("btnText");

    // إن كان الأستاذ مسجّل الدخول أصلًا، حوّله مباشرة إلى لوحة التحكم
    auth.onAuthStateChanged((user) => {
      if (user && !user.isAnonymous) {
        window.location.href = "teacher-dashboard.html";
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAlert(alertBox);
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;

      if (!email || !password) {
        showAlert(alertBox, "يرجى إدخال اسم المستخدم وكلمة المرور.", "error");
        return;
      }

      submitBtn.disabled = true;
      btnText.innerHTML = '<span class="spinner"></span> جاري التحقق...';

      try {
        await teacherLogin(email, password);
        window.location.href = "teacher-dashboard.html";
      } catch (err) {
        console.error(err);
        showAlert(alertBox, translateError(err), "error");
        submitBtn.disabled = false;
        btnText.textContent = "تسجيل الدخول";
      }
    });
